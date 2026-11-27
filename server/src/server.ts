import express from 'express';
import cors from 'cors';
import { execSync, execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { ensureDatabaseExists } from './db';
import { PrismaClient } from '@prisma/client';
import { streamInvoicePdf, streamBookingReceiptPdf, streamRentalOrderPdf } from './pdf';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { sendEmail, buildVerificationEmail, buildPasswordResetEmail, devEmailLog, CLIENT_URL } from './email';
import {
  getBackupConfig, saveBackupConfig, listBackups, runBackup, restoreBackup,
  backupFilePath, deleteBackup, getLastBackup, maybeRunScheduledBackup,
} from './backup';
import {
  MODULES, fullAccess, noAccess, defaultStaffPermissions, sanitizeMatrix, can as canDo,
  type Action, type PermissionMatrix,
} from './permissions';
import {
  LICENSE_ENFORCED, getLicenseStatus, getFingerprint, activateLicense, initLicense,
  signLicense, canSignLicenses,
} from './license';
import {
  createTicket, getTicket, replyToTicket, searchKb, absoluteAttachmentUrl,
  isSupportConfigured, SUPPORT_SYSTEM_NAME, MidwaySupportError,
} from './midway-support';
import {
  round2, resolveTaxRate, normalizeUnitPrice, feeLine, taxSummary, taxCategoryLabel,
  amountInWords, buildInvoiceLines, DEFAULT_TAX_RATES, type DraftLine,
} from './invoicing';
import {
  loadTaxContext, draftLinesFromOrder, priced, createInvoice as createInvoiceRecord,
  upsertPenaltyInvoice as upsertPenaltyInvoiceRecord, creditNoteLinesFromInvoice,
  INVOICE_INCLUDE, decorateInvoice, collectibleBalance, deriveInvoiceStatus, OPEN_INVOICE_STATUSES,
  type TaxContext, type Db,
} from './invoice-service';
import {
  DEFAULT_EFRIS_BASE_URL, resolveEfrisConfig, maskApiKey, efrisRequest, EfrisError,
  unitCode, legacyUnitToEfris, buildRegisterProductPayload, buildInvoicePayload,
  buildCreditNotePayload, buildStockIncreasePayload, buildStockDecreasePayload,
  summarizeFiscalResponse, extractTaxpayer, catalogItemCode, fiscalReference, creditNoteReasonCode,
  STOCK_IN_TYPES, STOCK_ADJUST_TYPES, CREDIT_NOTE_REASONS, type EfrisConfig,
} from './efris';

const prisma = new PrismaClient();
const app = express();

// Caddy terminates TLS and proxies to this container over plain HTTP, so
// `req.protocol` reported "http" for requests that arrived as HTTPS. That is
// not cosmetic: the sitemap index and robots.txt build absolute URLs from
// `req.protocol`, so hires.midwayug.com was publishing a sitemap full of
// http:// locations. Search engines treat http:// and https:// as different
// sites, so every URL submitted was the wrong one.
//
// `1` = trust exactly one hop (Caddy). The rate limiter reads x-forwarded-for
// itself and is unaffected by this.
app.set('trust proxy', 1);

const PORT = process.env.PORT || 20090;
const API_BASE = process.env.API_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());

const rateLimitEnabled = process.env.RATE_LIMIT_ENABLED === 'true';
const rateLimitRequests = parseInt(process.env.RATE_LIMIT_REQUESTS || '150');
const rateLimitWindow = parseInt(process.env.RATE_LIMIT_WINDOW || '60') * 1000; // in milliseconds

// Cache structure: ip -> { count, resetTime }
const rateLimitCache = new Map<string, { count: number; resetTime: number }>();

const rateLimitMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Only rate-limit the API. Static client assets are served from this same
  // origin (single-container web deploy) and must never count toward the budget,
  // or a normal page load (many JS chunks/fonts) could trip the limiter.
  if (!rateLimitEnabled || !req.path.startsWith('/api/')) {
    return next();
  }

  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown-ip';
  const now = Date.now();

  let clientData = rateLimitCache.get(ip);

  if (!clientData || now > clientData.resetTime) {
    clientData = {
      count: 0,
      resetTime: now + rateLimitWindow
    };
  }

  clientData.count++;
  rateLimitCache.set(ip, clientData);

  const remaining = Math.max(0, rateLimitRequests - clientData.count);
  const resetSeconds = Math.ceil((clientData.resetTime - now) / 1000);

  res.setHeader('X-RateLimit-Limit', rateLimitRequests);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', resetSeconds);

  if (clientData.count > rateLimitRequests) {
    return res.status(429).json({ error: 'Too many requests, please try again later.' });
  }

  next();
};

app.use(rateLimitMiddleware);

// License enforcement (desktop only — gated by LICENSE_ENFORCED; a no-op for
// dev and the hosted web version). When the trial/grace window is exhausted,
// block all business API calls but keep auth, health, and the license endpoints
// reachable so the user can still sign in and activate a key.
const LICENSE_ALLOW_PREFIXES = ['/api/license', '/api/auth', '/api/health', '/api/config'];
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!LICENSE_ENFORCED) return next();
  if (!req.path.startsWith('/api/')) return next(); // sitemap.xml, robots.txt, etc.
  if (LICENSE_ALLOW_PREFIXES.some(p => req.path.startsWith(p))) return next();
  const status = getLicenseStatus();
  if (status.blocked) {
    return res.status(402).json({ error: status.message, license: status });
  }
  next();
});

// ── GLOBAL AUTHENTICATION GATE ─────────────────────────────────────────────
// Every /api/ route requires a valid login session (x-session-token) EXCEPT an
// explicit public allowlist: the auth endpoints themselves, health/config, the
// license status/activation (desktop gate), public pricing, and the public
// storefront (/api/public/*). Super-admin routes carry their own x-admin-token
// guard (requireSuperuser) so they're excluded here. Non-/api paths (the static
// client, sitemap, robots) pass straight through. This closes the earlier gap
// where business READ endpoints (bookings, invoices, customers, …) returned data
// with no session — the route-permission table only covered mutations + a few
// financial reads.
const PUBLIC_API_EXACT = new Set<string>([
  '/api/health',
  '/api/config',
  '/api/subscription-plans', // public pricing (plan names/prices) — shown pre-login
]);
const PUBLIC_API_PREFIXES = ['/api/auth/', '/api/public/', '/api/license/'];
// Installation-wide (not tenant-scoped) API areas.
const INSTALLATION_API_PREFIXES = ['/api/backup/', '/api/system/'];

// Whole-database backups contain EVERY company's records. On a shared/hosted
// installation only platform operators (superusers) may list, download, run,
// restore or delete them. The self-contained desktop build (embedded DB, one
// business per installation) treats the database as that business's own, so a
// user with Business Settings → manage may administer it. Override with
// BACKUPS_INSTALLATION_SCOPED=true|false.
const BACKUPS_INSTALLATION_SCOPED = process.env.BACKUPS_INSTALLATION_SCOPED
  ? process.env.BACKUPS_INSTALLATION_SCOPED === 'true'
  : process.env.EMBEDDED_DB === 'true';
app.use(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!req.path.startsWith('/api/')) return next();       // static client, sitemap, robots
  if (req.path.startsWith('/api/admin/')) return next();  // guarded by x-admin-token (requireSuperuser)
  // dev-emails leaks captured verification/reset links — never expose it publicly.
  const isPublic = req.path !== '/api/auth/dev-emails'
    && (PUBLIC_API_EXACT.has(req.path) || PUBLIC_API_PREFIXES.some(p => req.path.startsWith(p)));
  if (isPublic) return next();
  const sess = await resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  // Authoritative identity for downstream audit attribution (getActor).
  (req as any).__authUsername = sess.username;
  // Bind the tenant ONCE from the session. getCompanyId() reads only this value;
  // client-supplied x-company-id headers, ?companyId= and body.companyId are
  // ignored/overwritten so a user can never act on another company's records.
  (req as any).__isSuperuser = sess.isSuperuser;
  if (sess.companyId == null) {
    // Platform operators have no tenant. They may reach installation-level
    // routes (backups, system health) but never tenant business data.
    if (sess.isSuperuser && INSTALLATION_API_PREFIXES.some(p => req.path.startsWith(p))) return next();
    return res.status(403).json({ error: 'Your account is not linked to a company.' });
  }
  (req as any).__tenantCompanyId = sess.companyId;
  (req as any).__isSuperuser = sess.isSuperuser;
  // Always set (not only when sent): 16 legacy handlers still read
  // body.companyId, and must get the session's tenant whatever the client sends.
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && req.method !== 'GET') {
    req.body.companyId = sess.companyId;
  }
  if (req.query && 'companyId' in req.query) (req.query as any).companyId = String(sess.companyId);
  next();
});

// ── INSTALLATION-LEVEL GUARDS (backups, system health) ─────────────────────
app.use('/api/backup', async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if ((req as any).__isSuperuser) return next();
  if (BACKUPS_INSTALLATION_SCOPED && await requirePermission(req, res, 'settings', 'manage')) return next();
  if (res.headersSent) return;
  return res.status(403).json({ error: 'Database backups are managed by the platform operator.' });
});
app.use('/api/system', (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Status board is readable by any signed-in user; changing it is platform-only.
  if (req.method === 'GET' || (req as any).__isSuperuser) return next();
  return res.status(403).json({ error: 'Only the platform operator can update system status.' });
});

// ── TENANT OWNERSHIP GUARD ─────────────────────────────────────────────────
// Every route that addresses a record by ID in its path is checked here, once,
// against the session-bound tenant. A record belonging to another company is
// reported as 404 (not 403) so IDs can't be probed across tenants. Handlers keep
// their own checks too; this is the single authoritative gate.
const OWNED_PATHS: { re: RegExp; model: string }[] = [
  { re: /^\/api\/customers\/(\d+)(\/|$)/,              model: 'customer' },
  { re: /^\/api\/customer-accounts\/(\d+)(\/|$)/,      model: 'customer' },
  { re: /^\/api\/serialized-assets\/(\d+)(\/|$)/,      model: 'serializedAsset' },
  { re: /^\/api\/maintenance-events\/(\d+)(\/|$)/,     model: 'maintenanceEvent' },
  { re: /^\/api\/functions\/(\d+)(\/|$)/,              model: 'functionEvent' },
  { re: /^\/api\/function-items\/(\d+)(\/|$)/,         model: 'functionItemAssignment' },
  { re: /^\/api\/checklist-items\/(\d+)(\/|$)/,        model: 'functionChecklistItem' },
  { re: /^\/api\/issues\/(\d+)(\/|$)/,                 model: 'functionIssue' },
  { re: /^\/api\/function-expenses\/(\d+)(\/|$)/,      model: 'functionExpense' },
  { re: /^\/api\/function-templates\/(\d+)(\/|$)/,     model: 'functionTemplate' },
  { re: /^\/api\/consumables\/(\d+)(\/|$)/,            model: 'consumable' },
  { re: /^\/api\/items\/(\d+)(\/|$)/,                  model: 'item' },
  { re: /^\/api\/sites\/(\d+)(\/|$)/,                  model: 'site' },
  { re: /^\/api\/purchase-orders\/(\d+)(\/|$)/,        model: 'purchaseOrder' },
  { re: /^\/api\/payroll-payments\/(\d+)(\/|$)/,       model: 'payrollPayment' },
  { re: /^\/api\/payroll-periods\/(\d+)(\/|$)/,        model: 'payrollPeriod' },
  { re: /^\/api\/bookings\/(\d+)(\/|$)/,               model: 'booking' },
  { re: /^\/api\/rental-orders\/(\d+)(\/|$)/,          model: 'rentalOrder' },
  { re: /^\/api\/invoices\/(\d+)(\/|$)/,               model: 'invoice' },
  { re: /^\/api\/credit-notes\/(\d+)(\/|$)/,           model: 'creditNote' },
  { re: /^\/api\/tax-rates\/(\d+)(\/|$)/,              model: 'taxRate' },
  { re: /^\/api\/notifications\/(\d+)(\/|$)/,          model: 'notification' },
  { re: /^\/api\/saved-searches\/(\d+)(\/|$)/,         model: 'savedSearch' },
];
app.use(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const companyId = (req as any).__tenantCompanyId;
  if (typeof companyId !== 'number') return next(); // public / admin routes: not tenant-scoped
  // A tenant may only address its own company record.
  const co = /^\/api\/companies\/(\d+)(\/|$)/.exec(req.path);
  if (co && parseInt(co[1]) !== companyId) return res.status(404).json({ error: 'Company not found.' });
  const rule = OWNED_PATHS.find(r => r.re.test(req.path));
  try {
    if (rule) {
      const id = parseInt(rule.re.exec(req.path)![1]);
      const n = await (prisma as any)[rule.model].count({ where: { id, companyId } });
      if (n === 0) return res.status(404).json({ error: 'Record not found.' });
    }
    // Related records referenced from the request body must belong to the same
    // tenant too (e.g. assigning another company's employee, or booking another
    // company's catalog item). /api/company/* uses roleId for CompanyRole and
    // checks that inline.
    if (req.method !== 'GET' && req.body && typeof req.body === 'object' && !req.path.startsWith('/api/company/')) {
      let refs: Array<[string, string, any]>;
      try { refs = bodyForeignRefs(req.path, req.body); }
      catch (e: any) { if (e instanceof BodyTooLarge) return res.status(413).json({ error: e.message }); throw e; }
      const bad = await firstForeignId(companyId, refs);
      if (bad) return res.status(400).json({ error: `Referenced ${bad} does not belong to your company.` });
    }
    next();
  } catch {
    return res.status(503).json({ error: 'Could not verify record ownership. Please try again.' });
  }
});

// Body fields that reference tenant-owned records, mapped to their model.
const BODY_FK_FIELDS: Record<string, string> = {
  employeeId: 'employee', assignedEmployeeId: 'employee', supplierId: 'supplier',
  taxRateId: 'taxRate', customerId: 'customer',
  itemId: 'item', assetId: 'serializedAsset', consumableId: 'consumable',
};
// Largest line array any endpoint accepts. Requests over it are rejected
// outright, so every accepted entry is ownership-checked (no partial scan).
const MAX_BODY_LINES = 500;
// CSV imports legitimately carry whole catalogues; still every row is checked.
const MAX_IMPORT_ROWS = 10000;
class BodyTooLarge extends Error {}
function bodyForeignRefs(path: string, body: any): Array<[string, string, any]> {
  const refs: Array<[string, string, any]> = [];
  const scan = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, model] of Object.entries(BODY_FK_FIELDS)) if (k in obj) refs.push([k, model, obj[k]]);
  };
  scan(body);
  // Every top-level array of objects, not just known keys, so a new endpoint
  // with a differently named line array is still covered.
  const max = path.startsWith('/api/import/') ? MAX_IMPORT_ROWS : MAX_BODY_LINES;
  for (const value of Object.values(body)) {
    if (!Array.isArray(value)) continue;
    if (value.length > max) throw new BodyTooLarge(`At most ${max} lines can be submitted at once.`);
    value.forEach(scan);
  }
  if (/^\/api\/functions\/\d+\/assign$/.test(path) && 'roleId' in body) refs.push(['roleId', 'functionRole', body.roleId]);
  return refs;
}

// Verifies that every given foreign-key ID (from a request body) belongs to the
// tenant. Returns the first offending field name, or null if all are owned.
async function firstForeignId(companyId: number, refs: Array<[string, string, any]>): Promise<string | null> {
  // Group by model and check each group with one query, so validating every
  // line of a large submission stays cheap.
  const byModel = new Map<string, { ids: Set<number>; field: string }>();
  for (const [field, model, raw] of refs) {
    if (raw === undefined || raw === null || raw === '') continue;
    const id = typeof raw === 'number' ? raw : (/^\d+$/.test(String(raw).trim()) ? parseInt(String(raw)) : NaN);
    if (!Number.isSafeInteger(id)) return field;
    const g = byModel.get(model) || { ids: new Set<number>(), field };
    g.ids.add(id);
    byModel.set(model, g);
  }
  for (const [model, { ids, field }] of byModel) {
    const n = await (prisma as any)[model].count({ where: { id: { in: [...ids] }, companyId } });
    if (n !== ids.size) return field;
  }
  return null;
}

// ── TENANT RBAC ENFORCEMENT ────────────────────────────────────────────────
// Server-side permission gate so business-role restrictions are real, not just
// UI hiding. Maps mutating endpoints (and financial reads) to a required
// (module, action); unmapped routes pass through. System admins always pass.
// getPermissionContext resolves the actor from the x-username header (same trust
// model as x-company-id). Company/role/user management endpoints self-guard
// inline with requirePermission, so they're intentionally omitted here.
const ROUTE_PERMISSIONS: { method: string; re: RegExp; module: string; action: Action }[] = [
  // Bookings
  { method: 'POST',   re: /^\/api\/bookings$/,                       module: 'bookings',    action: 'create' },
  { method: 'POST',   re: /^\/api\/bookings\/\d+\/confirm-deposit$/, module: 'bookings',    action: 'edit'   },
  // Dispatches & returns
  { method: 'POST',   re: /^\/api\/bookings\/\d+\/dispatch$/,        module: 'dispatches',  action: 'create' },
  { method: 'POST',   re: /^\/api\/rental-orders\/\d+\/apply-late-fee$/, module: 'dispatches', action: 'edit' },
  { method: 'POST',   re: /^\/api\/rental-orders\/\d+\/return$/,     module: 'dispatches',  action: 'edit'   },
  // Customers
  { method: 'POST',   re: /^\/api\/customers$/,                      module: 'customers',   action: 'create' },
  { method: 'PATCH',  re: /^\/api\/customers\/\d+$/,                  module: 'customers',   action: 'edit'   },
  { method: 'PATCH',  re: /^\/api\/customers\/\d+\/watchlist$/,      module: 'customers',   action: 'edit'   },
  { method: 'POST',   re: /^\/api\/import\/customers$/,              module: 'customers',   action: 'create' },
  // Customer ledgers (financial)
  { method: 'GET',    re: /^\/api\/customer-accounts(\/|$)/,         module: 'ledgers',     action: 'view'   },
  { method: 'PUT',    re: /^\/api\/customer-accounts\/\d+$/,         module: 'ledgers',     action: 'edit'   },
  { method: 'POST',   re: /^\/api\/customer-accounts\/\d+\/transactions$/, module: 'ledgers', action: 'edit' },
  { method: 'POST',   re: /^\/api\/customer-accounts\/recalculate$/, module: 'ledgers',    action: 'edit'   },
  // Inventory
  { method: 'POST',   re: /^\/api\/items$/,                          module: 'inventory',   action: 'create' },
  { method: 'POST',   re: /^\/api\/serialized-assets$/,              module: 'inventory',   action: 'create' },
  { method: 'PATCH',  re: /^\/api\/serialized-assets\/\d+$/,         module: 'inventory',   action: 'edit'   },
  { method: 'POST',   re: /^\/api\/serialized-assets\/\d+\/maintenance$/, module: 'inventory', action: 'edit' },
  { method: 'POST',   re: /^\/api\/maintenance-events\/\d+\/complete$/, module: 'inventory', action: 'edit' },
  { method: 'POST',   re: /^\/api\/consumables$/,                    module: 'inventory',   action: 'create' },
  { method: 'PATCH',  re: /^\/api\/items\/\d+$/,                      module: 'inventory',   action: 'edit'   },
  { method: 'PATCH',  re: /^\/api\/consumables\/\d+$/,                module: 'inventory',   action: 'edit'   },
  { method: 'POST',   re: /^\/api\/consumables\/\d+\/(use|restock)$/, module: 'inventory',  action: 'edit'   },
  { method: 'POST',   re: /^\/api\/import\/(items|assets|consumables)$/, module: 'inventory', action: 'create' },
  // Staff & scheduling
  { method: 'POST',   re: /^\/api\/employees$/,                      module: 'staff',       action: 'create' },
  { method: 'POST',   re: /^\/api\/sites$/,                          module: 'staff',       action: 'create' },
  { method: 'POST',   re: /^\/api\/sites\/\d+\/assign$/,             module: 'staff',       action: 'edit'   },
  { method: 'POST',   re: /^\/api\/import\/employees$/,              module: 'staff',       action: 'create' },
  // Events / functions
  { method: 'POST',   re: /^\/api\/functions$/,                      module: 'events',      action: 'create' },
  { method: 'POST',   re: /^\/api\/functions\/\d+\/(assign|items|checklist|issues|activities|expenses|revenue|complete|signatures)$/, module: 'events', action: 'edit' },
  { method: 'PUT',    re: /^\/api\/(checklist-items|issues)\/\d+$/,  module: 'events',      action: 'edit'   },
  { method: 'DELETE', re: /^\/api\/function-items\/\d+$/,            module: 'events',      action: 'edit'   },
  { method: 'POST',   re: /^\/api\/function-items\/\d+\/(dispatch|return)$/, module: 'events', action: 'edit' },
  { method: 'DELETE', re: /^\/api\/function-expenses\/\d+$/,         module: 'events',      action: 'edit'   },
  { method: 'POST',   re: /^\/api\/function-templates$/,             module: 'events',      action: 'create' },
  { method: 'POST',   re: /^\/api\/function-templates\/\d+\/(items|create-function)$/, module: 'events', action: 'edit' },
  { method: 'DELETE', re: /^\/api\/function-templates\/\d+$/,        module: 'events',      action: 'delete' },
  { method: 'DELETE', re: /^\/api\/function-template-items\/\d+$/,   module: 'events',      action: 'edit'   },
  // Revenue (financial)
  { method: 'GET',    re: /^\/api\/income(\/|$|\?)/,                 module: 'revenue',     action: 'view'   },
  { method: 'GET',    re: /^\/api\/income$/,                         module: 'revenue',     action: 'view'   },
  { method: 'POST',   re: /^\/api\/income$/,                         module: 'revenue',     action: 'create' },
  // Purchases & payroll (financial)
  { method: 'POST',   re: /^\/api\/suppliers$/,                      module: 'purchases',   action: 'create' },
  { method: 'POST',   re: /^\/api\/purchase-orders$/,                module: 'purchases',   action: 'create' },
  { method: 'PATCH',  re: /^\/api\/purchase-orders\/\d+\/status$/,   module: 'purchases',   action: 'edit'   },
  { method: 'POST',   re: /^\/api\/expenses$/,                       module: 'purchases',   action: 'create' },
  { method: 'POST',   re: /^\/api\/payroll-periods$/,                module: 'purchases',   action: 'create' },
  { method: 'POST',   re: /^\/api\/payroll-payments\/\d+\/pay$/,     module: 'purchases',   action: 'edit'   },
  { method: 'PATCH',  re: /^\/api\/payroll-periods\/\d+\/status$/,   module: 'purchases',   action: 'edit'   },
  // Invoices & credit notes (financial)
  { method: 'POST',   re: /^\/api\/invoices$/,                       module: 'invoices',    action: 'create' },
  { method: 'PATCH',  re: /^\/api\/invoices\/\d+$/,                   module: 'invoices',    action: 'edit'   },
  { method: 'DELETE', re: /^\/api\/invoices\/\d+$/,                   module: 'invoices',    action: 'delete' },
  { method: 'POST',   re: /^\/api\/invoices\/\d+\/pay$/,             module: 'invoices',    action: 'edit'   },
  { method: 'POST',   re: /^\/api\/invoices\/\d+\/fiscalize$/,       module: 'efris',       action: 'submit' },
  { method: 'POST',   re: /^\/api\/invoices\/\d+\/credit-memo$/,     module: 'creditNotes', action: 'create' },
  { method: 'POST',   re: /^\/api\/credit-notes\/\d+\/fiscalize$/,   module: 'efris',       action: 'submit' },
  // Tax rates (business settings)
  { method: 'POST',   re: /^\/api\/tax-rates(\/defaults)?$/,          module: 'settings',    action: 'manage' },
  { method: 'PATCH',  re: /^\/api\/tax-rates\/\d+$/,                  module: 'settings',    action: 'manage' },
  { method: 'DELETE', re: /^\/api\/tax-rates\/\d+$/,                  module: 'settings',    action: 'manage' },
  // URA EFRIS
  { method: 'POST',   re: /^\/api\/efris\/settings$/,                 module: 'efris',       action: 'manage' },
  { method: 'POST',   re: /^\/api\/efris\/test$/,                     module: 'efris',       action: 'manage' },
  { method: 'POST',   re: /^\/api\/efris\/sync-excise-codes$/,        module: 'efris',       action: 'manage' },
  { method: 'POST',   re: /^\/api\/efris\/register\/[a-z]+\/\d+$/,    module: 'efris',       action: 'register' },
  { method: 'POST',   re: /^\/api\/efris\/stock-(increase|decrease)$/, module: 'efris',      action: 'stock'  },
  // Business settings + backup
  { method: 'PATCH',  re: /^\/api\/companies\/\d+\/settings$/,       module: 'settings',    action: 'manage' },
  { method: 'PUT',    re: /^\/api\/backup\/config$/,                 module: 'settings',    action: 'manage' },
  { method: 'POST',   re: /^\/api\/backup\/(run|restore)$/,          module: 'settings',    action: 'manage' },
  { method: 'DELETE', re: /^\/api\/backup\//,                        module: 'settings',    action: 'manage' },
];

app.use(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const rule = ROUTE_PERMISSIONS.find(r => r.method === req.method && r.re.test(req.path));
  if (!rule) return next();
  try {
    const ctx = await getPermissionContext(req);
    if (!ctx.authenticated) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    if (canDo(ctx, rule.module, rule.action)) return next();
    return res.status(403).json({ error: `You don't have permission to ${rule.action === 'manage' ? 'manage' : rule.action} ${rule.module}.` });
  } catch {
    // Fail closed: a permission-lookup error must never grant access.
    return res.status(503).json({ error: 'Could not verify your permissions. Please try again.' });
  }
});

// Seeding function to populate database on initial run
async function seedDatabase() {
  const companyCount = await prisma.company.count();
  if (companyCount === 0) {
    console.log("Seeding initial database data...");
    
    // Create subscription plans
    const freePlan = await prisma.subscriptionPlan.create({
      data: {
        name: "Free Basic Tier",
        planType: "free",
        priceMonthly: 0.00,
        maxUsers: 2,
        maxItems: 20,
        isActive: true
      }
    });

    const profPlan = await prisma.subscriptionPlan.create({
      data: {
        name: "Professional Tier",
        planType: "professional",
        priceMonthly: 49000.00,
        maxUsers: 10,
        maxItems: 200,
        isActive: true
      }
    });

    const plan = await prisma.subscriptionPlan.create({
      data: {
        name: "Enterprise Plan",
        planType: "pro",
        priceMonthly: 150000.00,
        maxUsers: 50,
        maxItems: 5000,
        isActive: true
      }
    });

    // Demo tenants/users are opt-in. A fresh installation must never ship
    // accounts with a known password; businesses sign up via registration.
    if (process.env.SEED_DEMO_DATA !== 'true') {
      console.log('Subscription plans created. Demo data skipped (set SEED_DEMO_DATA=true to load it).');
      return;
    }
    const demoPassword = process.env.SEED_DEMO_PASSWORD || crypto.randomBytes(9).toString('base64url');
    if (!process.env.SEED_DEMO_PASSWORD) {
      console.log(`[Seed] Demo users admin / kampala_admin / staff created with one-time password: ${demoPassword}`);
    }

    // Create company
    const company = await prisma.company.create({
      data: {
        name: "Mega Rentals Uganda Ltd",
        publicSlug: "mega-rentals",
        planId: plan.id,
        currency: "UGX",
        isActive: true,
        publicBookingsEnabled: true,
        bookingExpirationHours: 24
      }
    });

    // Create Kampala Event Planners company
    const company2 = await prisma.company.create({
      data: {
        name: "Kampala Event Planners",
        publicSlug: "kampala-events",
        planId: plan.id,
        currency: "UGX",
        isActive: true,
        publicBookingsEnabled: true,
        bookingExpirationHours: 24
      }
    });

    // Create Users & UserProfiles
    const user1 = await prisma.user.create({
      data: {
        username: "admin",
        email: "admin@mega.ug",
        password: hashPassword(demoPassword),
        firstName: "Mega",
        lastName: "Admin"
      }
    });
    await prisma.userProfile.create({
      data: {
        userId: user1.id,
        companyId: company.id,
        role: "Admin"
      }
    });

    const user2 = await prisma.user.create({
      data: {
        username: "kampala_admin",
        email: "kampala@events.ug",
        password: hashPassword(demoPassword),
        firstName: "Kampala",
        lastName: "Admin"
      }
    });
    await prisma.userProfile.create({
      data: {
        userId: user2.id,
        companyId: company2.id,
        role: "Admin"
      }
    });

    const user3 = await prisma.user.create({
      data: {
        username: "staff",
        email: "staff@mega.ug",
        password: hashPassword(demoPassword),
        firstName: "Mega",
        lastName: "Staff"
      }
    });
    await prisma.userProfile.create({
      data: {
        userId: user3.id,
        companyId: company.id,
        role: "User"
      }
    });

    // Create default items
    const items = await Promise.all([
      prisma.item.create({ data: { companyId: company.id, name: "Executive Plastic Chairs", category: "Chairs", unitOfMeasure: "piece", unitCost: 10000, unitReplacementCost: 15000, dailyRentalRate: 2500, currentStock: 450 } }),
      prisma.item.create({ data: { companyId: company.id, name: "Banquet Decorated Chair", category: "Chairs", unitOfMeasure: "piece", unitCost: 25000, unitReplacementCost: 35000, dailyRentalRate: 5000, currentStock: 150 } }),
      prisma.item.create({ data: { companyId: company.id, name: "Double Pyramidal Tent (100-seater)", category: "Tents", unitOfMeasure: "piece", unitCost: 800000, unitReplacementCost: 1200000, dailyRentalRate: 150000, currentStock: 12 } }),
      prisma.item.create({ data: { companyId: company.id, name: "Sound System (Medium Event Pack)", category: "Sound", unitOfMeasure: "piece", unitCost: 3500000, unitReplacementCost: 4500000, dailyRentalRate: 350000, currentStock: 4 } }),
      prisma.item.create({ data: { companyId: company.id, name: "50kVA Silent Diesel Generator", category: "Power", unitOfMeasure: "piece", unitCost: 22000000, unitReplacementCost: 28000000, dailyRentalRate: 450000, currentStock: 2 } })
    ]);

    // Create Customer
    const customer = await prisma.customer.create({
      data: {
        companyId: company.id,
        name: "Sarah Kabasomi",
        contactInfo: "sarah@gmail.com, +256772123456",
        isOnWatchList: false
      }
    });

    // Create Booking
    await prisma.booking.create({
      data: {
        companyId: company.id,
        customerId: customer.id,
        bookingNumber: "B-2026-101",
        customerName: "Sarah Kabasomi",
        contactInfo: "sarah@gmail.com, +256772123456",
        bookingType: "customer",
        scheduledPickupDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // 2 days from now
        scheduledReturnDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5 days from now
        estimatedTotalCost: 757500.00,
        depositAmount: 200000.00,
        depositPaid: true,
        depositPaidDate: new Date(),
        status: "confirmed"
      }
    });

    // Create active RentalOrder
    const order = await prisma.rentalOrder.create({
      data: {
        companyId: company.id,
        customerId: customer.id,
        customerName: "Sarah Kabasomi",
        checkoutDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
        expectedReturnDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago (overdue)
        status: "Active",
        companyOrderNumber: "RO-2026-809",
        isFinalized: false,
        totalAmountPaid: 200000.00,
        estimatedTotal: 757500.00
      }
    });

    // Standard Uganda tax rates. Seeded inactive-free and tax-inclusive, so the
    // demo figures below stay exactly as they were before tax existed.
    const seededRates = [];
    for (const r of DEFAULT_TAX_RATES) {
      seededRates.push(await prisma.taxRate.create({ data: { ...r, companyId: company.id } }));
    }
    const standardRate = seededRates.find(r => r.taxCode === '01')!;

    // Create Unpaid Invoice matching the order, itemised.
    const seedNet = Math.round(757500 / (1 + Number(standardRate.rate)));
    const seedTax = 757500 - seedNet;
    await prisma.invoice.create({
      data: {
        companyId: company.id,
        referenceNumber: "INV-2026-401",
        customerId: customer.id,
        customerName: "Sarah Kabasomi",
        invoiceType: "RENTAL",
        rentalOrderId: order.id,
        currency: company.currency,
        subtotal: seedNet,
        taxTotal: seedTax,
        amount: 757500.00,
        amountPaid: 200000.00,
        dueDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
        status: "Unpaid",
        description: "Rental Order #RO-2026-809",
        lineItems: {
          create: [{
            itemType: 'fee',
            description: 'Event equipment hire — Order #RO-2026-809',
            quantity: 1,
            rentalDays: 1,
            unitPrice: seedNet,
            taxRateId: standardRate.id,
            taxRatePercent: Number(standardRate.rate),
            taxCode: standardRate.taxCode,
            lineNet: seedNet,
            lineTax: seedTax,
            lineTotal: 757500.00,
          }]
        }
      }
    });

    // Create Function Roles
    const roles = await Promise.all([
      prisma.functionRole.create({ data: { companyId: company.id, name: "Usher", description: "Responsible for guest welcoming and seating" } }),
      prisma.functionRole.create({ data: { companyId: company.id, name: "Service Coordinator", description: "Manages schedule and timeline of the event" } }),
      prisma.functionRole.create({ data: { companyId: company.id, name: "Sound Engineer", description: "Responsible for audio setups and microphones" } }),
      prisma.functionRole.create({ data: { companyId: company.id, name: "Logistics Crew", description: "Handles item loading and site assembly" } })
    ]);

    // Create Employees
    const employees = await Promise.all([
      prisma.employee.create({
        data: {
          companyId: company.id,
          name: "James Kigozi",
          role: "Usher Team Lead",
          billingRateToClient: 15000.00,
          payStructure: "Per Function",
          payRate: 8000.00,
          isActive: true
        }
      }),
      prisma.employee.create({
        data: {
          companyId: company.id,
          name: "Anita Namubiru",
          role: "Service Coordinator",
          billingRateToClient: 25000.00,
          payStructure: "Daily",
          payRate: 15000.00,
          isActive: true
        }
      }),
      prisma.employee.create({
        data: {
          companyId: company.id,
          name: "Peter Ochieng",
          role: "Sound Engineer",
          billingRateToClient: 35000.00,
          payStructure: "Per Function",
          payRate: 20000.00,
          isActive: true
        }
      })
    ]);

    // Create Job Sites
    const sites = await Promise.all([
      prisma.site.create({
        data: {
          companyId: company.id,
          name: "Speke Resort Munyonyo",
          location: "Munyonyo, Kampala",
          contactPerson: "Manager Isaac",
          contactInfo: "+256 701 445566",
          notes: "Requires generator setup on the lakeside lawns."
        }
      }),
      prisma.site.create({
        data: {
          companyId: company.id,
          name: "Sheraton Kampala Hotel",
          location: "Ternan Avenue, Kampala",
          contactPerson: "Esther Kemigisha",
          contactInfo: "+256 772 889900",
          notes: "Access from secondary cargo bay only."
        }
      })
    ]);

    // Assign Peter to Speke Resort Munyonyo
    await prisma.siteAssignment.create({
      data: {
        companyId: company.id,
        siteId: sites[0].id,
        employeeId: employees[2].id,
        isPrimary: true,
        notes: "Primary sound engineer for lakeside events"
      }
    });

    // Create a Function Event
    const eventDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // in 5 days
    const event = await prisma.functionEvent.create({
      data: {
        companyId: company.id,
        name: "Mukasa Memorial Ceremony",
        date: eventDate,
        time: "10:00 AM",
        location: "Speke Resort Munyonyo",
        clientName: "David Mukasa",
        clientContact: "+256 752 909090",
        notes: " lakeside lawn layout setup",
        status: "Scheduled"
      }
    });

    // Assign James and Anita to the event
    await prisma.functionAssignment.create({
      data: {
        companyId: company.id,
        functionId: event.id,
        employeeId: employees[0].id,
        roleId: roles[0].id,
        status: "Confirmed",
        startTime: "08:00 AM",
        endTime: "04:00 PM",
        notes: "Coordinate guest seating at lakeside gates."
      }
    });
    await prisma.functionAssignment.create({
      data: {
        companyId: company.id,
        functionId: event.id,
        employeeId: employees[1].id,
        roleId: roles[1].id,
        status: "Confirmed",
        startTime: "07:00 AM",
        endTime: "05:00 PM",
        notes: "Event manager. Synchronize program with Speke crew."
      }
    });

    // Create Suppliers
    const suppliers = await Promise.all([
      prisma.supplier.create({
        data: {
          companyId: company.id,
          name: "Elite Tent Manufacturers Ltd",
          contactPerson: "Mr. Moses Kintu",
          phone: "+256 702 334455",
          email: "sales@elitetents.co.ug",
          address: "Kibuye Road, Kampala",
          notes: "Lead time is 7 days for custom banners."
        }
      }),
      prisma.supplier.create({
        data: {
          companyId: company.id,
          name: "Standard Generator Parts Co.",
          contactPerson: "Eng. Ronald Mukasa",
          phone: "+256 782 112233",
          email: "info@stdgenparts.ug",
          address: "Industrial Area, Kampala",
          notes: "Net 15 terms."
        }
      })
    ]);

    // Create a Purchase Order
    await prisma.purchaseOrder.create({
      data: {
        companyId: company.id,
        supplierId: suppliers[0].id,
        poNumber: "PO-2026-901",
        orderDate: new Date().toISOString().split('T')[0],
        deliveryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        totalAmount: 6000000.00, // 5 x 1,200,000
        status: "Ordered",
        notes: "Restocking double pyramidal tents.",
        lineItems: {
          create: [
            {
              companyId: company.id,
              itemId: items[2].id, // Double Pyramidal Tent
              description: "Double Pyramidal Tent (100-seater) - Standard White PVC",
              quantity: 5,
              unitCost: 1200000,
              totalCost: 6000000
            }
          ]
        }
      }
    });

    // Create Expenses
    await Promise.all([
      prisma.expense.create({
        data: {
          companyId: company.id,
          supplierId: suppliers[1].id,
          amount: 150000.00,
          expenseCategory: "Fuel",
          expenseDate: new Date().toISOString().split('T')[0],
          paymentMethod: "Mobile Money",
          notes: "Fuel for 50kVA generator setup at Munyonyo."
        }
      }),
      prisma.expense.create({
        data: {
          companyId: company.id,
          amount: 800000.00,
          expenseCategory: "Rent",
          expenseDate: new Date().toISOString().split('T')[0],
          paymentMethod: "Bank Transfer",
          notes: "July monthly warehouse space rental."
        }
      })
    ]);

    // Create a Payroll Period
    const startWeek = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const payrollPeriod = await prisma.payrollPeriod.create({
      data: {
        companyId: company.id,
        startDate: startWeek,
        endDate: endWeek,
        status: "Open",
        totalSpent: 23000.00
      }
    });

    // Create payroll payments
    await Promise.all([
      prisma.payrollPayment.create({
        data: {
          companyId: company.id,
          payrollPeriodId: payrollPeriod.id,
          employeeId: employees[0].id,
          amount: 8000.00,
          status: "Unpaid",
          notes: `Event: "Mukasa Memorial Ceremony" (Per Function @ UGX 8,000)`
        }
      }),
      prisma.payrollPayment.create({
        data: {
          companyId: company.id,
          payrollPeriodId: payrollPeriod.id,
          employeeId: employees[1].id,
          amount: 15000.00,
          status: "Unpaid",
          notes: `Date: ${eventDate} (Daily Pay @ UGX 15,000)`
        }
      })
    ]);

    // Create default audit logs
    await Promise.all([
      prisma.auditLog.create({
        data: {
          companyId: company.id,
          username: "admin",
          action: "EMAIL_DISPATCH",
          modelName: "Booking",
          objectId: 1,
          objectRepr: "B-2026-9901",
          additionalInfo: `Simulated booking confirmation email dispatched to Sarah Kabasomi (Sarah.k@gmail.com). Estimated Total: UGX 1,500,000, Deposit: UGX 300,000.`
        }
      }),
      prisma.auditLog.create({
        data: {
          companyId: company.id,
          username: "admin",
          action: "EMAIL_DISPATCH",
          modelName: "Invoice",
          objectId: 1,
          objectRepr: "INV-2026-8802",
          additionalInfo: `Simulated invoice payment receipt email dispatched to Sarah Kabasomi. Amount Paid: UGX 300,000 via Cash. notes: Seed deposit payment.`
        }
      })
    ]);

    console.log("Seeding completed successfully.");
  }
}

// Helper: Calculate days between dates
function getDaysBetween(start: Date, end: Date): number {
  const diff = end.getTime() - start.getTime();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  return days > 0 ? days : 1;
}

// Endpoints

// 1. Health check
// Build stamp written by client/src-tauri/build-payload.sh, so an installed
// desktop app can be checked against the revision it was meant to ship.
const BUILD_INFO: { revision?: string; builtAt?: string } = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')); }
  catch { return {}; }
})();
const MIGRATION_COUNT = (() => {
  try { return fs.readdirSync(path.join(__dirname, '..', 'prisma', 'migrations')).filter(n => /^\d/.test(n)).length; }
  catch { return null; }
})();

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', service: 'YourHires API Service',
    revision: BUILD_INFO.revision || 'dev', builtAt: BUILD_INFO.builtAt || null,
    migrations: MIGRATION_COUNT,
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    sessionCookieAge: parseInt(process.env.SESSION_COOKIE_AGE || '600'),
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED === 'true'
  });
});


async function logAudit(companyId: number, username: string, action: string, modelName: string, objectId: number | null, objectRepr: string, message: string) {
  try {
    const entry = await prisma.auditLog.create({
      data: {
        companyId,
        username,
        action,
        modelName,
        objectId,
        objectRepr,
        additionalInfo: message
      }
    });
    console.log(`[AUDIT LOG] ${action} on ${modelName} (${objectRepr}): ${message}`);
    return entry;
  } catch (err: any) {
    console.error("Failed to write audit log:", err.message);
  }
}

// Actor for the audit trail. Prefers the authoritative username resolved from the
// session token (set on req by the RBAC enforcement middleware for guarded routes);
// otherwise falls back to the best-effort x-username header, then 'system'.
function getActor(req: any): string {
  if (typeof req.__authUsername === 'string' && req.__authUsername) return req.__authUsername;
  const u = req.headers?.['x-username'];
  return (typeof u === 'string' && u.trim()) ? u.trim() : 'system';
}

// Convenience wrapper: derives company + actor from the request. Fire-and-forget
// (never throws — logAudit already swallows its own errors) so instrumenting an
// endpoint can never break the endpoint itself.
function audit(req: any, action: string, modelName: string, objectId: number | null, objectRepr: string, message: string) {
  return logAudit(getCompanyId(req), getActor(req), action, modelName, objectId, objectRepr, message);
}

// ── TENANT RBAC (business-level permissions) ───────────────────────────────
// Resolve the effective permission context from the AUTHORITATIVE session token
// (x-session-token). No valid session → authenticated:false, so guarded routes
// reject with 401 rather than trusting a spoofable header. System admins /
// superusers get full access; other users get their assigned role's matrix.
interface PermContext { userId: number | null; isSystemAdmin: boolean; permissions: PermissionMatrix; authenticated: boolean; }
async function getPermissionContext(req: any): Promise<PermContext> {
  const sess = await resolveSession(req);
  if (!sess) return { userId: null, isSystemAdmin: false, permissions: noAccess(), authenticated: false };
  // Record the authoritative identity for downstream audit attribution.
  req.__authUsername = sess.username;
  try {
    if (sess.isSuperuser) return { userId: sess.userId, isSystemAdmin: true, permissions: fullAccess(), authenticated: true };
    const user = await prisma.user.findUnique({
      where: { id: sess.userId },
      include: { profile: { include: { companyRole: true } } },
    });
    const role = user?.profile?.companyRole;
    const coarseAdmin = user?.profile?.role === 'Admin';
    if (coarseAdmin || role?.isSystemAdmin) return { userId: sess.userId, isSystemAdmin: true, permissions: fullAccess(), authenticated: true };
    return { userId: sess.userId, isSystemAdmin: false, permissions: sanitizeMatrix(role?.permissions), authenticated: true };
  } catch {
    return { userId: sess.userId, isSystemAdmin: false, permissions: noAccess(), authenticated: true };
  }
}

// Guard a handler: returns true if allowed, else sends 401 (no session) / 403
// (forbidden) and returns false.
async function requirePermission(req: any, res: any, moduleKey: string, action: Action): Promise<boolean> {
  const ctx = await getPermissionContext(req);
  if (!ctx.authenticated) { res.status(401).json({ error: 'Your session has expired. Please sign in again.' }); return false; }
  if (canDo(ctx, moduleKey, action)) return true;
  res.status(403).json({ error: `You don't have permission to ${action} ${moduleKey}.` });
  return false;
}

// ── AUTH HELPERS ─────────────────────────────────────────────────────────
const BCRYPT_ROUNDS = 10;
// bcrypt hashes start with $2a$ / $2b$ / $2y$; used to tell hashed from legacy plaintext.
function isBcryptHash(v: string) { return /^\$2[aby]\$/.test(v || ''); }
function hashPassword(pw: string) { return bcrypt.hashSync(pw, BCRYPT_ROUNDS); }
// Verifies a password, transparently supporting legacy plaintext records.
function passwordMatches(plain: string, stored: string) {
  return isBcryptHash(stored) ? bcrypt.compareSync(plain, stored) : plain === stored;
}
function makeToken() { return crypto.randomBytes(32).toString('hex'); }

class PublicBookingError extends Error {}

// Document references (bookings, orders, invoices, credit notes). A random
// 10-character suffix (~50 bits) with the current year — the old 4-digit
// space (9,000 numbers, fixed "2026") collided against unique constraints.
function makeReference(prefix: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  let suffix = '';
  for (const b of bytes) suffix += alphabet[b % alphabet.length];
  return `${prefix}-${new Date().getFullYear()}-${suffix}`;
}

// ── LOGIN SESSIONS (per-user, DB-backed) ───────────────────────────────────
// Issued at login, sent by the client as the x-session-token header. This is the
// AUTHORITATIVE identity for permission enforcement — unlike x-username, it can't
// be forged. DB-backed so sessions survive server restarts.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
async function createSession(userId: number): Promise<string> {
  const token = makeToken();
  await prisma.session.create({ data: { token, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
  return token;
}
async function resolveSession(req: any): Promise<{ userId: number; username: string; companyId: number | null; isSuperuser: boolean } | null> {
  const token = req.headers?.['x-session-token'];
  if (typeof token !== 'string' || !token) return null;
  try {
    const sess = await prisma.session.findUnique({ where: { token }, include: { user: { include: { profile: true } } } });
    if (!sess) return null;
    if (sess.expiresAt < new Date()) { prisma.session.delete({ where: { token } }).catch(() => {}); return null; }
    if (!sess.user || !sess.user.isActive) return null;
    return { userId: sess.user.id, username: sess.user.username, companyId: sess.user.profile?.companyId ?? null, isSuperuser: sess.user.isSuperuser };
  } catch { return null; }
}
async function destroySession(token: string) {
  try { await prisma.session.delete({ where: { token } }); } catch { /* already gone */ }
}

// ── SUPER-ADMIN SESSIONS ───────────────────────────────────────────────────
// Platform (superuser) console auth. Unlike the tenant app — which trusts the
// x-company-id header — super-admin endpoints require a real bearer token issued
// at login and sent as `x-admin-token`, so tenant admins can't reach them by
// spoofing a header. Tokens live in memory (a server restart forces re-login),
// which is acceptable for this single-server deployment.
const adminSessions = new Map<string, { userId: number; username: string; expiresAt: number }>();
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function issueAdminSession(userId: number, username: string): string {
  const token = makeToken();
  adminSessions.set(token, { userId, username, expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
  return token;
}

// Returns the session if the request carries a valid, unexpired admin token whose
// user is still an active superuser; otherwise null.
async function requireSuperuser(req: any): Promise<{ userId: number; username: string } | null> {
  const token = req.headers?.['x-admin-token'];
  if (typeof token !== 'string' || !token) return null;
  const sess = adminSessions.get(token);
  if (!sess || sess.expiresAt < Date.now()) { if (sess) adminSessions.delete(token); return null; }
  const user = await prisma.user.findUnique({ where: { id: sess.userId } });
  if (!user || !user.isActive || !user.isSuperuser) { adminSessions.delete(token); return null; }
  return { userId: sess.userId, username: sess.username };
}

// Issues a single-use auth token (email verification / password reset).
async function issueAuthToken(userId: number, purpose: 'email_verification' | 'password_reset', ttlMs: number) {
  // Invalidate any outstanding tokens of the same purpose for this user.
  await prisma.authToken.deleteMany({ where: { userId, purpose, usedAt: null } });
  const token = makeToken();
  await prisma.authToken.create({
    data: { userId, token, purpose, expiresAt: new Date(Date.now() + ttlMs) }
  });
  return token;
}

// ── CUSTOMER LEDGER HELPER FUNCTIONS ─────────────────────────────────────

async function resolveCustomerByName(customerName: string, companyId: number, contactInfo: string = '') {
  let customer = await prisma.customer.findFirst({
    where: {
      companyId,
      name: customerName.trim()
    }
  });
  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        companyId,
        name: customerName.trim(),
        contactInfo: contactInfo || '',
        isOnWatchList: false
      }
    });
  }
  return customer;
}

async function getOrCreateCustomerAccount(customerId: number, companyId: number) {
  let account = await prisma.customerAccount.findUnique({
    where: { customerId }
  });
  if (!account) {
    account = await prisma.customerAccount.create({
      data: {
        customerId,
        creditLimit: 0,
        paymentTermsDays: 30,
        totalOutstanding: 0,
        totalOverdue: 0,
        currentBalance: 0,
        balance31_60: 0,
        balance61_90: 0,
        balanceOver90: 0
      }
    });
  }
  return account;
}

async function recalculateCustomerBalance(customerId: number, companyId: number) {
  const account = await getOrCreateCustomerAccount(customerId, companyId);

  // Get all transactions for this account sorted chronologically
  const transactions = await prisma.customerAccountTransaction.findMany({
    where: { accountId: account.id },
    orderBy: { createdAt: 'asc' }
  });

  let totalOutstanding = 0;
  let lastPaymentDate: Date | null = null;
  let lastPaymentAmount = 0;

  // Process transactions chronologically to update running balance_after_transaction
  for (const tx of transactions) {
    const amount = Number(tx.amount);
    totalOutstanding += amount;

    await prisma.customerAccountTransaction.update({
      where: { id: tx.id },
      data: { balanceAfterTransaction: totalOutstanding }
    });

    // Track last payment info (credits)
    if (amount < 0) {
      if (!lastPaymentDate || tx.createdAt > lastPaymentDate) {
        lastPaymentDate = tx.createdAt;
        lastPaymentAmount = Math.abs(amount);
      }
    }
  }

  // Calculate aging buckets based on unpaid debits
  let currentBalance = 0;
  let balance31_60 = 0;
  let balance61_90 = 0;
  let balanceOver90 = 0;
  let totalOverdue = 0;

  // Get all debit transactions (charges, invoices, late fees, adjustments > 0)
  const debits = transactions.filter(tx => Number(tx.amount) > 0);

  let runningBalance = totalOutstanding;
  const now = new Date();

  // Sort debits by due date or created date to allocate payments (FIFO/outstanding allocation)
  const sortedDebits = debits.sort((a, b) => {
    const dateA = a.dueDate ? new Date(a.dueDate).getTime() : a.createdAt.getTime();
    const dateB = b.dueDate ? new Date(b.dueDate).getTime() : b.createdAt.getTime();
    return dateA - dateB;
  });

  for (const debit of sortedDebits) {
    if (runningBalance <= 0) break;

    const debitAmount = Number(debit.amount);
    const debitOutstanding = Math.min(debitAmount, runningBalance);

    if (debit.dueDate) {
      const dueDate = new Date(debit.dueDate);
      const diffTime = now.getTime() - dueDate.getTime();
      const daysOld = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (daysOld > 0) {
        totalOverdue += debitOutstanding;
      }

      if (daysOld <= 30) {
        currentBalance += debitOutstanding;
      } else if (daysOld <= 60) {
        balance31_60 += debitOutstanding;
      } else if (daysOld <= 90) {
        balance61_90 += debitOutstanding;
      } else {
        balanceOver90 += debitOutstanding;
      }
    } else {
      // No due date goes to current
      currentBalance += debitOutstanding;
    }

    runningBalance -= debitOutstanding;
  }

  // Save the updated account details
  const updatedAccount = await prisma.customerAccount.update({
    where: { id: account.id },
    data: {
      totalOutstanding: Math.max(0, totalOutstanding),
      totalOverdue: Math.max(0, totalOverdue),
      currentBalance: Math.max(0, currentBalance),
      balance31_60: Math.max(0, balance31_60),
      balance61_90: Math.max(0, balance61_90),
      balanceOver90: Math.max(0, balanceOver90),
      // update payment metadata
      // (Prisma requires a Date object or null for lastPaymentDate)
      ...(lastPaymentDate ? { lastPaymentDate } : {})
    }
  });

  return updatedAccount;
}

async function createAccountTransaction(params: {
  customerId: number;
  companyId: number;
  transactionType: string; // 'invoice' | 'payment' | 'credit_memo' | 'adjustment' | 'refund' | 'late_fee' | 'damage_fee' | 'booking_deposit'
  amount: number; // positive for debits, negative for credits
  description: string;
  dueDate?: Date;
  referenceNumber?: string;
}) {
  const account = await getOrCreateCustomerAccount(params.customerId, params.companyId);

  // Create the transaction
  const tx = await prisma.customerAccountTransaction.create({
    data: {
      accountId: account.id,
      transactionType: params.transactionType,
      amount: params.amount,
      balanceAfterTransaction: 0, // will be recalculated
      description: params.description,
      dueDate: params.dueDate || null,
      referenceNumber: params.referenceNumber || null
    }
  });

  // Recalculate balances
  await recalculateCustomerBalance(params.customerId, params.companyId);

  return tx;
}

// Inserts one ledger row inside a caller's transaction (creating the account
// if needed). Running balances/aging are derived data: call
// recalculateCustomerBalance after the transaction commits.
async function postLedgerEntry(db: Db, params: {
  customerId: number; transactionType: string; amount: number;
  description: string; dueDate?: Date; referenceNumber?: string;
}) {
  let account = await db.customerAccount.findUnique({ where: { customerId: params.customerId } });
  if (!account) {
    account = await db.customerAccount.create({
      data: { customerId: params.customerId, creditLimit: 0, paymentTermsDays: 30, totalOutstanding: 0,
        totalOverdue: 0, currentBalance: 0, balance31_60: 0, balance61_90: 0, balanceOver90: 0 },
    });
  }
  return db.customerAccountTransaction.create({
    data: {
      accountId: account.id, transactionType: params.transactionType, amount: params.amount,
      balanceAfterTransaction: 0, description: params.description,
      dueDate: params.dueDate || null, referenceNumber: params.referenceNumber || null,
    },
  });
}

// Records income inside a caller's transaction. Unlike recordIncome it THROWS,
// so a failed income write rolls the whole posting back instead of leaving the
// invoice and ledger saying "paid" with no matching revenue.
async function recordIncomeTx(db: Db, params: {
  companyId: number; incomeSource: string; amount: number; paymentMethod: string;
  description: string; referenceNumber?: string; baseRentalAmount?: number; depositAmount?: number; otherFeeAmount?: number;
}) {
  const company = await db.company.findUnique({ where: { id: params.companyId }, select: { currency: true } });
  return db.income.create({
    data: {
      companyId: params.companyId, currency: company?.currency || 'UGX', incomeSource: params.incomeSource,
      amount: params.amount, paymentMethod: params.paymentMethod, referenceNumber: params.referenceNumber || null,
      description: params.description, baseRentalAmount: params.baseRentalAmount || 0, lateFeeAmount: 0,
      damageFeeAmount: 0, depositAmount: params.depositAmount || 0, otherFeeAmount: params.otherFeeAmount || 0,
    },
  });
}

// Helper to record cash inflows to the Consolidated Revenue Ledger
async function recordIncome(params: {
  companyId: number;
  incomeSource: string;
  amount: number;
  paymentMethod: string;
  description: string;
  referenceNumber?: string;
  baseRentalAmount?: number;
  lateFeeAmount?: number;
  damageFeeAmount?: number;
  depositAmount?: number;
  otherFeeAmount?: number;
}) {
  try {
    const company = await prisma.company.findUnique({
      where: { id: params.companyId }
    });
    const currency = company?.currency || 'UGX';

    const record = await prisma.income.create({
      data: {
        companyId: params.companyId,
        currency,
        incomeSource: params.incomeSource,
        amount: params.amount,
        paymentMethod: params.paymentMethod,
        referenceNumber: params.referenceNumber || null,
        description: params.description,
        baseRentalAmount: params.baseRentalAmount || 0,
        lateFeeAmount: params.lateFeeAmount || 0,
        damageFeeAmount: params.damageFeeAmount || 0,
        depositAmount: params.depositAmount || 0,
        otherFeeAmount: params.otherFeeAmount || 0
      }
    });
    return record;
  } catch (err) {
    console.error('Failed to record ledger income:', err);
    return null;
  }
}

// ── RETURN / RECONCILIATION HELPERS ──────────────────────────────────────

// Single source of truth for the late-fee formula, shared by the return and
// apply-late-fee endpoints (previously they used two divergent formulas).
// Fee = Σ (dailyRate × lateFeePercentPerDay% × daysOverdue × rentedQty).
function computeLateFee(
  lineItems: { dailyRate: any; rentedQty: number }[],
  expectedReturnDate: Date | string,
  asOf: Date,
  lateFeePercentPerDay: number
): { lateFee: number; daysOverdue: number } {
  const daysOverdue = Math.max(0, Math.ceil(
    (asOf.getTime() - new Date(expectedReturnDate).getTime()) / (1000 * 60 * 60 * 24)
  ));
  if (daysOverdue <= 0) return { lateFee: 0, daysOverdue: 0 };
  const rate = (Number(lateFeePercentPerDay) || 0) / 100;
  const lateFee = lineItems.reduce(
    (sum, li) => sum + Number(li.dailyRate) * rate * daysOverdue * (li.rentedQty || 0),
    0
  );
  return { lateFee: Math.round(lateFee), daysOverdue };
}

// Idempotent penalty/charge invoice keyed by a deterministic reference, so
// re-applying a fee updates the existing invoice instead of duplicating it.
// The fee arrives as the gross amount the business means to collect; the line
// and its tax are worked backwards from that (see invoice-service).
async function upsertPenaltyInvoice(
  companyId: number, ref: string, customerName: string,
  amount: number, description: string, dueDate: Date,
  opts?: { customerId?: number | null; rentalOrderId?: number | null; db?: Db }
) {
  const db = opts?.db || prisma;
  const ctx = await loadTaxContext(prisma, companyId);
  const customer = opts?.customerId
    ? await db.customer.findUnique({ where: { id: opts.customerId }, select: { taxId: true } })
    : null;
  return upsertPenaltyInvoiceRecord(db, ctx, {
    companyId,
    reference: ref,
    customerId: opts?.customerId ?? null,
    customerName,
    customerTin: customer?.taxId ?? null,
    grossAmount: amount,
    description,
    dueDate,
    rentalOrderId: opts?.rentalOrderId ?? null,
  });
}

// Applies the tax / EFRIS catalogue fields shared by items, assets and
// consumables, leaving anything the caller didn't send untouched.
function efrisCatalogFields(body: any) {
  const data: any = {};
  if (body.sku !== undefined) data.sku = body.sku?.trim() || null;
  if (body.unitOfMeasureId !== undefined) data.unitOfMeasureId = body.unitOfMeasureId ? parseInt(body.unitOfMeasureId) : null;
  if (body.taxRateId !== undefined) data.taxRateId = body.taxRateId ? parseInt(body.taxRateId) : null;
  if (body.commodityCode !== undefined) data.commodityCode = body.commodityCode?.trim() || null;
  if (body.haveExciseTax !== undefined) data.haveExciseTax = body.haveExciseTax === '101' ? '101' : '102';
  if (body.exciseDutyCode !== undefined) {
    // URA rejects a duty code on a product not marked as excisable, so the two
    // fields are only ever saved consistently.
    data.exciseDutyCode = data.haveExciseTax === '101' ? (body.exciseDutyCode?.trim() || null) : null;
  }
  return data;
}

// Raises the invoice for a dispatched rental order: one line per hired item or
// consumable sold, priced from the order and taxed by the company's rates.
// Returns null when the order has nothing billable on it.
async function createOrderInvoice(
  companyId: number, orderId: number, orderNumber: string,
  customerId: number, customerName: string, dueDate: Date,
  depositPaid: number, description: string,
  opts?: { rentalDays?: number; db?: Db }
) {
  const db = opts?.db || prisma;
  const order = await db.rentalOrder.findUnique({
    where: { id: orderId },
    include: {
      lineItems: {
        include: {
          item: { select: { name: true, taxRateId: true, unitOfMeasureId: true } },
          asset: { select: { name: true, serialNumber: true, taxRateId: true, unitOfMeasureId: true } },
          consumable: { select: { name: true, taxRateId: true, unitOfMeasureId: true } },
        }
      }
    }
  });
  if (!order || order.lineItems.length === 0) return null;

  const ctx = await loadTaxContext(prisma, companyId);
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { taxId: true } });
  const lines = draftLinesFromOrder(order as any, ctx, { rentalDays: opts?.rentalDays });

  return createInvoiceRecord(db, ctx, {
    companyId,
    referenceNumber: `INV-${orderNumber}`,
    customerId,
    customerName,
    customerTin: customer?.taxId ?? null,
    invoiceType: 'RENTAL',
    rentalOrderId: orderId,
    description,
    dueDate,
    amountPaid: depositPaid,
    lines,
  });
}

// Idempotent ledger charge keyed by (type, reference): clears any prior charge
// with the same key then re-adds the current amount.
async function chargeLedgerOnce(
  customerId: number, companyId: number, transactionType: string,
  ref: string, amount: number, description: string, dueDate: Date
) {
  const account = await getOrCreateCustomerAccount(customerId, companyId);
  await prisma.customerAccountTransaction.deleteMany({
    where: { accountId: account.id, transactionType, referenceNumber: ref }
  });
  if (amount > 0) {
    await createAccountTransaction({
      customerId, companyId, transactionType,
      amount: Math.round(amount), description, dueDate, referenceNumber: ref
    });
  } else {
    await recalculateCustomerBalance(customerId, companyId);
  }
}

// ── NOTIFICATIONS ──────────────────────────────────────────────────────────

// Create an in-app notification. `dedupeLink` (optional) prevents piling up
// duplicate unread notifications for the same subject (e.g. the overdue scanner
// re-running, or repeated low-stock dips on the same item).
async function createNotification(params: {
  companyId: number; category: string; title: string; message: string;
  link?: string; dedupe?: boolean;
}) {
  try {
    if (params.dedupe && params.link) {
      const existing = await prisma.notification.findFirst({
        where: { companyId: params.companyId, category: params.category, link: params.link, isRead: false }
      });
      if (existing) {
        // Refresh the existing unread notification instead of adding another.
        await prisma.notification.update({
          where: { id: existing.id },
          data: { title: params.title, message: params.message, createdAt: new Date() }
        });
        return existing;
      }
    }
    return await prisma.notification.create({
      data: {
        companyId: params.companyId, category: params.category,
        title: params.title, message: params.message, link: params.link || null
      }
    });
  } catch (err: any) {
    console.error('Failed to create notification:', err.message);
    return null;
  }
}

// Raise a low-stock notification if an item has dipped to/below its threshold.
async function checkItemLowStock(itemId: number, companyId: number) {
  try {
    const item = await prisma.item.findUnique({ where: { id: itemId } });
    if (!item) return;
    if (item.currentStock <= item.lowStockThreshold) {
      await createNotification({
        companyId, category: 'low_stock',
        title: `Low stock: ${item.name}`,
        message: `${item.name} is down to ${item.currentStock} unit(s) (threshold ${item.lowStockThreshold}). Consider restocking.`,
        link: `item-${item.id}`, dedupe: true,
      });
    }
  } catch { /* non-fatal */ }
}

app.get('/api/audit-logs', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const take = Math.min(500, Math.max(1, parseInt((req.query.limit as string) || '200')));
    const list = await prisma.auditLog.findMany({
      where: { companyId },
      orderBy: { id: 'desc' },
      take
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DATABASE BACKUP & RESTORE ────────────────────────────────────────────
// Whole-database operations (admin-only; the client gates these behind Settings).
// See server/src/backup.ts for the retention/safety guarantees.

// Backup settings + status (config, existing backups, last-backup summary)
app.get('/api/backup/config', (req, res) => {
  try {
    res.json({ config: getBackupConfig(), backups: listBackups(), lastBackup: getLastBackup() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update auto-backup settings (enabled / hour / retention / dir)
app.put('/api/backup/config', (req, res) => {
  try {
    const { enabled, hour, retention, dir } = req.body || {};
    const config = saveBackupConfig({ enabled, hour, retention, dir });
    res.json({ config, backups: listBackups(), lastBackup: getLastBackup() });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Run a backup right now ("Backup now")
app.post('/api/backup/run', async (req, res) => {
  try {
    const result = await runBackup('manual');
    res.json({ ...result, backups: listBackups(), lastBackup: getLastBackup() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Download an existing backup file
app.get('/api/backup/download/:name', (req, res) => {
  const full = backupFilePath(req.params.name);
  if (!full) return res.status(404).json({ error: 'Backup not found.' });
  res.download(full, req.params.name);
});

// Delete a specific backup file (never blocks — it's an explicit admin action)
app.delete('/api/backup/:name', (req, res) => {
  try {
    if (!deleteBackup(req.params.name)) return res.status(404).json({ error: 'Backup not found.' });
    res.json({ ok: true, backups: listBackups(), lastBackup: getLastBackup() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Restore the database from a backup. DESTRUCTIVE — overwrites current data.
// Requires an explicit confirmation token and takes an automatic pre-restore
// safety snapshot first, so a mistaken restore is always recoverable.
app.post('/api/backup/restore', async (req, res) => {
  const { name, confirm } = req.body || {};
  if (confirm !== 'RESTORE') {
    return res.status(400).json({ error: 'Restore not confirmed. Send { confirm: "RESTORE" }.' });
  }
  if (!backupFilePath(name)) return res.status(404).json({ error: 'Backup not found.' });
  try {
    // Safety net: snapshot current state before overwriting it.
    let safety: string | null = null;
    try { safety = (await runBackup('prerestore')).file; }
    catch (e: any) { return res.status(500).json({ error: `Aborted: could not take a pre-restore safety backup (${e.message}). Nothing was changed.` }); }

    await restoreBackup(name);
    res.json({ ok: true, restored: name, safetyBackup: safety, backups: listBackups(), lastBackup: getLastBackup() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DESKTOP LICENSING ────────────────────────────────────────────────────
// Always reachable (even when blocked) so the user can view status and activate.

// Current license status + this machine's fingerprint.
app.get('/api/license/status', (req, res) => {
  res.json(getLicenseStatus());
});

// Just the machine fingerprint (what the user reads to the vendor).
app.get('/api/license/fingerprint', (req, res) => {
  res.json({ fingerprint: getFingerprint() });
});

// Activate a pasted license key.
app.post('/api/license/activate', (req, res) => {
  const { key } = req.body || {};
  if (!key || typeof key !== 'string') return res.status(400).json({ error: 'A license key is required.' });
  const result = activateLicense(key);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const licCompanyId = getOptionalCompanyId(req);
  if (licCompanyId != null) logAudit(licCompanyId, getActor(req), 'LICENSE_ACTIVATED', 'License', null, result.status?.licensee || getFingerprint(),
    `License activated${result.status?.expiresAt ? ` (expires ${result.status.expiresAt})` : ' (perpetual)'}.`);
  res.json(result.status);
});

// ── SUPER-ADMIN / PLATFORM CONSOLE ─────────────────────────────────────────
// All endpoints require a valid superuser session (x-admin-token). These bypass
// company scoping — they operate across all tenants.

// Platform-wide metrics.
app.get('/api/admin/metrics', async (req, res) => {
  if (!(await requireSuperuser(req))) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const [totalCompanies, activeCompanies, totalUsers, totalCustomers, totalOrders, revenueAgg] = await Promise.all([
      prisma.company.count(),
      prisma.company.count({ where: { isActive: true } }),
      prisma.user.count(),
      prisma.customer.count(),
      prisma.rentalOrder.count(),
      prisma.income.aggregate({ _sum: { amount: true } }),
    ]);
    res.json({
      totalCompanies,
      activeCompanies,
      suspendedCompanies: totalCompanies - activeCompanies,
      totalUsers,
      totalCustomers,
      totalOrders,
      totalRevenue: Number(revenueAgg._sum.amount || 0),
      canSignLicenses: canSignLicenses(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// All companies with plan, usage counts and status.
app.get('/api/admin/companies', async (req, res) => {
  if (!(await requireSuperuser(req))) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const companies = await prisma.company.findMany({
      orderBy: { id: 'asc' },
      include: {
        plan: true,
        _count: { select: { users: true, customers: true, rentalOrders: true, bookings: true } },
      },
    });
    res.json(companies.map(c => ({
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      isActive: c.isActive,
      paymentApprovalStatus: c.paymentApprovalStatus,
      plan: c.plan ? { id: c.plan.id, name: c.plan.name, planType: c.plan.planType, maxUsers: c.plan.maxUsers, maxItems: c.plan.maxItems } : null,
      trialActive: c.trialActive,
      trialEndsAt: c.trialEndsAt,
      publicBookingsEnabled: c.publicBookingsEnabled,
      createdAt: c.createdAt,
      counts: c._count,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update a tenant: suspend/reactivate (isActive), change plan, set billing status.
app.patch('/api/admin/companies/:id', async (req, res) => {
  const admin = await requireSuperuser(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized.' });
  const id = parseInt(req.params.id);
  const { isActive, planId, paymentApprovalStatus } = req.body || {};
  try {
    const existing = await prisma.company.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Company not found.' });

    const data: any = {};
    if (typeof isActive === 'boolean') data.isActive = isActive;
    if (planId !== undefined) data.planId = planId === null ? null : parseInt(planId);
    if (typeof paymentApprovalStatus === 'string') data.paymentApprovalStatus = paymentApprovalStatus;
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No changes provided.' });

    const updated = await prisma.company.update({ where: { id }, data, include: { plan: true } });

    // Audit into the affected company's own trail so it's visible to them too.
    const changes: string[] = [];
    if (data.isActive !== undefined) changes.push(data.isActive ? 'reactivated' : 'suspended');
    if (data.planId !== undefined) changes.push(`plan → ${updated.plan?.name || 'none'}`);
    if (data.paymentApprovalStatus !== undefined) changes.push(`billing → ${data.paymentApprovalStatus}`);
    await logAudit(id, admin.username, 'PLATFORM_ADMIN', 'Company', id, updated.name,
      `Platform admin ${admin.username}: ${changes.join(', ')}.`);

    res.json({ ok: true, company: { id: updated.id, name: updated.name, isActive: updated.isActive, paymentApprovalStatus: updated.paymentApprovalStatus, planId: updated.planId } });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Generate a desktop license key (vendor-side; needs the private signing key).
app.post('/api/admin/licenses/generate', async (req, res) => {
  const admin = await requireSuperuser(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized.' });
  const { fingerprint, days, plan, licensee } = req.body || {};
  if (!fingerprint || typeof fingerprint !== 'string') return res.status(400).json({ error: 'A machine fingerprint is required.' });
  try {
    const key = signLicense({ fp: fingerprint, days: days ? parseInt(days) : 0, plan, licensee });
    await logAudit(1, admin.username, 'LICENSE_ISSUED', 'License', null, licensee || fingerprint,
      `Platform admin ${admin.username} issued a license for ${fingerprint}${days ? ` (${days} days)` : ' (perpetual)'}.`);
    res.json({ key, fingerprint, days: days ? parseInt(days) : 0, plan: plan || null, licensee: licensee || null });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// List notifications for the company (+ unread count)
app.get('/api/notifications', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const [list, unread] = await Promise.all([
      prisma.notification.findMany({ where: { companyId }, orderBy: { id: 'desc' }, take: 100 }),
      prisma.notification.count({ where: { companyId, isRead: false } }),
    ]);
    res.json({ notifications: list, unread });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Lightweight unread-count poll
app.get('/api/notifications/count', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const unread = await prisma.notification.count({ where: { companyId, isRead: false } });
    res.json({ unread });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Mark one notification read
app.post('/api/notifications/:id/read', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    await prisma.notification.updateMany({ where: { id, companyId }, data: { isRead: true } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Mark all read
app.post('/api/notifications/mark-all-read', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    await prisma.notification.updateMany({ where: { companyId, isRead: false }, data: { isRead: true } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Per-user notification preferences (userId identifies the team member)
app.get('/api/notifications/preferences', async (req, res) => {
  const userId = parseInt(req.query.userId as string);
  if (!userId) return res.status(400).json({ error: 'userId is required.' });
  try {
    let prefs = await prisma.notificationPreference.findUnique({ where: { userId } });
    if (!prefs) prefs = await prisma.notificationPreference.create({ data: { userId } });
    res.json(prefs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/notifications/preferences', async (req, res) => {
  const { userId, overdue, lowStock, returns, payments, bookings } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required.' });
  try {
    const data: any = {};
    for (const [k, v] of Object.entries({ overdue, lowStock, returns, payments, bookings })) {
      if (v !== undefined) data[k] = !!v;
    }
    const prefs = await prisma.notificationPreference.upsert({
      where: { userId: parseInt(userId) },
      update: data,
      create: { userId: parseInt(userId), ...data },
    });
    res.json(prefs);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── GLOBAL SEARCH ──────────────────────────────────────────────────────────
// Searches across the main entities and returns grouped results, each pointing
// at the client tab that renders it. MySQL's default collation is case-insensitive.
app.get('/api/search', async (req, res) => {
  const companyId = getCompanyId(req);
  const q = (req.query.q as string || '').trim();
  if (q.length < 2) return res.json({ groups: [], total: 0 });
  const like = { contains: q };
  const TAKE = 6;
  try {
    const [customers, orders, bookings, items, assets, invoices, employees] = await Promise.all([
      prisma.customer.findMany({ where: { companyId, OR: [{ name: like }, { contactInfo: like }] }, take: TAKE }),
      prisma.rentalOrder.findMany({ where: { companyId, OR: [{ companyOrderNumber: like }, { customerName: like }] }, take: TAKE, orderBy: { id: 'desc' } }),
      prisma.booking.findMany({ where: { companyId, OR: [{ bookingNumber: like }, { customerName: like }] }, take: TAKE, orderBy: { id: 'desc' } }),
      prisma.item.findMany({ where: { companyId, OR: [{ name: like }, { category: like }] }, take: TAKE }),
      prisma.serializedAsset.findMany({ where: { companyId, OR: [{ name: like }, { serialNumber: like }, { assetType: like }] }, take: TAKE }),
      prisma.invoice.findMany({ where: { companyId, OR: [{ referenceNumber: like }, { customerName: like }] }, take: TAKE, orderBy: { id: 'desc' } }),
      prisma.employee.findMany({ where: { companyId, OR: [{ name: like }, { role: like }] }, take: TAKE }),
    ]);

    const groups = [
      { type: 'customers', label: 'Customers', tab: 'customers', items: customers.map(c => ({ id: c.id, label: c.name, sublabel: c.contactInfo || '' })) },
      { type: 'orders', label: 'Rental Orders', tab: 'dispatches', items: orders.map(o => ({ id: o.id, label: o.companyOrderNumber, sublabel: `${o.customerName} · ${o.status}` })) },
      { type: 'bookings', label: 'Bookings', tab: 'bookings', items: bookings.map(b => ({ id: b.id, label: b.bookingNumber, sublabel: `${b.customerName} · ${b.status}` })) },
      { type: 'items', label: 'Items', tab: 'inventory', items: items.map(i => ({ id: i.id, label: i.name, sublabel: `${i.category} · ${i.currentStock} in stock` })) },
      { type: 'assets', label: 'Serialized Assets', tab: 'inventory', items: assets.map(a => ({ id: a.id, label: a.name, sublabel: `${a.serialNumber} · ${a.status}` })) },
      { type: 'invoices', label: 'Invoices', tab: 'invoices', items: invoices.map(i => ({ id: i.id, label: i.referenceNumber, sublabel: `${i.customerName} · ${i.status}` })) },
      { type: 'employees', label: 'Staff', tab: 'scheduling', items: employees.map(e => ({ id: e.id, label: e.name, sublabel: e.role || 'Staff' })) },
    ].filter(g => g.items.length > 0);

    const total = groups.reduce((s, g) => s + g.items.length, 0);
    res.json({ groups, total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── SAVED SEARCHES ─────────────────────────────────────────────────────────
app.get('/api/saved-searches', async (req, res) => {
  const companyId = getCompanyId(req);
  const userId = parseInt(req.query.userId as string) || null;
  try {
    const list = await prisma.savedSearch.findMany({
      where: { companyId, ...(userId ? { userId } : {}) },
      orderBy: { id: 'desc' },
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/saved-searches', async (req, res) => {
  const companyId = getCompanyId(req);
  const { userId, name, query } = req.body;
  if (!name || !query) return res.status(400).json({ error: 'name and query are required.' });
  try {
    const saved = await prisma.savedSearch.create({
      data: { companyId, userId: userId ? parseInt(userId) : null, name: String(name).slice(0, 100), query: String(query).slice(0, 255) },
    });
    res.status(201).json(saved);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/saved-searches/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    await prisma.savedSearch.deleteMany({ where: { id: parseInt(req.params.id), companyId } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── SETUP CHECKLIST / ONBOARDING ────────────────────────────────────────────
// Steps are derived live from real data rather than tracked separately, so the
// checklist can never drift out of sync with what the company has actually done.
app.get('/api/onboarding/status', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found.' });

    const [itemCount, assetCount, customerCount, bookingCount, orderCount, teamCount] = await Promise.all([
      prisma.item.count({ where: { companyId } }),
      prisma.serializedAsset.count({ where: { companyId } }),
      prisma.customer.count({ where: { companyId } }),
      prisma.booking.count({ where: { companyId } }),
      prisma.rentalOrder.count({ where: { companyId } }),
      prisma.userProfile.count({ where: { companyId } }),
    ]);

    const steps = [
      { id: 'catalog', label: 'Add your first item or asset', tab: 'inventory', done: (itemCount + assetCount) > 0 },
      { id: 'customer', label: 'Add a customer', tab: 'customers', done: customerCount > 0 },
      { id: 'booking', label: 'Create your first booking or rental order', tab: 'bookings', done: (bookingCount + orderCount) > 0 },
      { id: 'team', label: 'Invite a team member', tab: 'settings', done: teamCount > 1 },
      { id: 'public', label: 'Enable public bookings for your catalog', tab: 'settings', done: company.publicBookingsEnabled },
    ];

    const completedCount = steps.filter(s => s.done).length;
    const percent = Math.round((completedCount / steps.length) * 100);

    // Auto-complete once every step is satisfied (idempotent).
    let dismissed = company.onboardingComplete;
    if (percent === 100 && !dismissed) {
      await prisma.company.update({ where: { id: companyId }, data: { onboardingComplete: true } });
      dismissed = true;
    }

    res.json({ steps, percent, completedCount, total: steps.length, dismissed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Let the user hide the checklist even if not all steps are done yet.
app.post('/api/onboarding/dismiss', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    await prisma.company.update({ where: { id: companyId }, data: { onboardingComplete: true } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/subscription-plans', async (req, res) => {
  try {
    const list = await prisma.subscriptionPlan.findMany({
      where: { isActive: true }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies/subscription/upgrade', async (req, res) => {
  const { companyId, planId, cardHolderName } = req.body;
  if (!companyId || !planId) {
    return res.status(400).json({ error: 'companyId and planId are required.' });
  }
  try {
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: parseInt(planId) }
    });
    if (!plan) return res.status(404).json({ error: 'Subscription Plan not found.' });

    const company = await prisma.company.update({
      where: { id: parseInt(companyId) },
      data: { planId: plan.id },
      include: { plan: true }
    });

    await logAudit(
      company.id,
      'admin',
      'STRIPE_UPGRADE',
      'Company',
      company.id,
      company.name,
      `Simulated Stripe subscription payment confirmed for Professional/Enterprise plan [${plan.name}]. Cardholder: ${cardHolderName || 'Billing Account'}. Amount Billed: UGX ${Number(plan.priceMonthly).toLocaleString()}/month.`
    );

    res.json(company);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/public/:companySlug/catalog', async (req, res) => {
  const { companySlug } = req.params;
  try {
    const company = await prisma.company.findFirst({
      where: { publicSlug: companySlug, isActive: true, publicBookingsEnabled: true }
    });
    if (!company) {
      return res.status(404).json({ error: 'Company catalog not found or bookings disabled.' });
    }
    const items = await prisma.item.findMany({
      where: { companyId: company.id }
    });
    res.json({ company, items });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/public/:companySlug/bookings', async (req, res) => {
  const { companySlug } = req.params;
  const { customerName, contactInfo, bookingType, scheduledPickupDate, scheduledReturnDate, lineItems } = req.body;
  
  if (!customerName || !lineItems || lineItems.length === 0) {
    return res.status(400).json({ error: 'Customer name and line items are required.' });
  }

  try {
    const company = await prisma.company.findFirst({
      where: { publicSlug: companySlug, isActive: true, publicBookingsEnabled: true }
    });
    if (!company) {
      return res.status(404).json({ error: 'Company catalog not found or bookings disabled.' });
    }

    let estimatedTotal = 0;
    const parsedPickup = scheduledPickupDate ? new Date(scheduledPickupDate) : new Date();
    const parsedReturn = scheduledReturnDate ? new Date(scheduledReturnDate) : new Date(Date.now() + 86400000);
    const days = getDaysBetween(parsedPickup, parsedReturn);

    if (!Array.isArray(lineItems) || lineItems.length > 200) {
      return res.status(400).json({ error: 'Invalid line items.' });
    }
    const lineItemsWithRates = await Promise.all(lineItems.map(async (item: any) => {
      // Only this storefront's own catalog can be booked.
      const dbItem = await prisma.item.findFirst({ where: { id: parseInt(item.itemId), companyId: company.id } });
      if (!dbItem) throw new PublicBookingError(`Item ${item.itemId} not found in catalog.`);
      const quantity = parseInt(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) throw new PublicBookingError(`Invalid quantity for "${dbItem.name}".`);

      const dailyRate = Number(dbItem.dailyRentalRate);
      const lineCost = dailyRate * quantity * days;
      estimatedTotal += lineCost;

      return {
        // Same discriminator as internal bookings, so dispatch/return move stock.
        itemType: 'item',
        itemId: dbItem.id,
        quantity,
        dailyRateAtBooking: dailyRate,
        estimatedRentalDays: days,
        estimatedLineTotal: lineCost
      };
    }));

    const bookingNumber = makeReference('B-PUB');

    const booking = await prisma.booking.create({
      data: {
        companyId: company.id,
        customerName,
        contactInfo,
        bookingType: bookingType || 'pickup',
        scheduledPickupDate: parsedPickup,
        scheduledReturnDate: parsedReturn,
        estimatedTotalCost: estimatedTotal,
        depositAmount: estimatedTotal * 0.2,
        bookingNumber,
        status: 'pending',
        lineItems: {
          create: lineItemsWithRates.map(li => ({
            itemType: li.itemType,
            itemId: li.itemId,
            quantity: li.quantity,
            dailyRateAtBooking: li.dailyRateAtBooking,
            estimatedRentalDays: li.estimatedRentalDays,
            estimatedLineTotal: li.estimatedLineTotal
          }))
        }
      }
    });

    await logAudit(
      company.id,
      'anonymous',
      'PUBLIC_BOOKING',
      'Booking',
      booking.id,
      bookingNumber,
      `Public reservation submitted by ${customerName}. Estimated Total: UGX ${estimatedTotal.toLocaleString()}, Deposit required: UGX ${(estimatedTotal * 0.2).toLocaleString()}.`
    );

    res.json(booking);
  } catch (err: any) {
    if (err instanceof PublicBookingError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Could not submit booking. Please try again.' });
  }
});

// Global sitemap index: one entry per active, publicly-bookable company catalog.
// This is what search engines discover at the domain root; each entry points at
// that company's own /public/:slug/sitemap.xml (which lists the catalog + items).
app.get('/sitemap.xml', async (req, res) => {
  try {
    const companies = await prisma.company.findMany({
      where: { isActive: true, publicBookingsEnabled: true },
      select: { publicSlug: true },
    });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
    companies.forEach(c => {
      xml += `\n    <sitemap>\n        <loc>${baseUrl}/public/${c.publicSlug}/sitemap.xml</loc>\n    </sitemap>`;
    });
    xml += `\n</sitemapindex>`;
    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// Global robots.txt at the domain root — where crawlers look by default.
//
// The only public surface on this host is /public/<companySlug> — the bookable
// catalogues, and the per-item pages listed in each company's sitemap.
// Everything else is the operator dashboard behind a login.
//
// WHY DENY-BY-DEFAULT AND NOT `Allow: /public/` PLUS A DISALLOW LIST: this app
// is a single-page client, and the static-file fallback at the bottom of this
// file answers *every* unmatched GET with index.html and a 200. So a crawler
// that guesses /pricing, /careers or /dashboard does not get a 404 — it gets
// the same empty shell as everything else, 200 OK. Search Console files those
// as duplicates or soft 404s, which is what put ~131 URLs in the not-indexed
// report for sc-domain:midwayug.com. Listing paths to disallow cannot help
// when the set of 200-returning paths is infinite; only denying by default can.
//
// Google resolves conflicts by longest match, so `Allow: /public/` (8 chars)
// beats `Disallow: /` (1 char) for the catalogue pages and nothing else.
//
// `/assets/` is the built JS and CSS. It stays crawlable because there is no
// server-side rendering here: Googlebot has to execute the bundle to see any
// catalogue content at all, so blocking it would leave the allowed pages
// looking blank.
//
// For the same reason the catalogue's own data endpoint has to be reachable —
// /public/<slug> renders nothing until GET /api/public/<slug>/catalog answers.
// It is allowed by an exact pattern rather than by opening /api/public/,
// because the sibling endpoint /api/public/<slug>/bookings is POST-only: a
// crawler that GETs it receives 405, which Search Console reports as "Blocked
// due to other 4xx issue". That is precisely the bug that had to be fixed on
// efris.midwayug.com, where a `/owner/` rule failed to cover `/api/owner/*`.
// Crawlers that do not support `*` simply fall through to Disallow, which is
// the safe direction to fail in.
app.get('/robots.txt', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const robots = `User-agent: *
Disallow: /
Allow: /public/
Allow: /api/public/*/catalog
Allow: /assets/
Allow: /favicon.svg
Allow: /icons.svg
Allow: /sitemap.xml

Sitemap: ${baseUrl}/sitemap.xml
`;
  res.header('Content-Type', 'text/plain');
  res.send(robots);
});

app.get('/public/:companySlug/sitemap.xml', async (req, res) => {
  const { companySlug } = req.params;
  try {
    const company = await prisma.company.findFirst({
      where: { publicSlug: companySlug, isActive: true }
    });
    if (!company) return res.status(404).send('Company not found');

    const items = await prisma.item.findMany({
      where: { companyId: company.id }
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const catalogUrl = `${baseUrl}/public/${companySlug}`;

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>${catalogUrl}</loc>
        <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
    </url>`;

    items.forEach(item => {
      xml += `
    <url>
        <loc>${baseUrl}/public/${companySlug}/item/${item.id}</loc>
        <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>`;
    });

    xml += `\n</urlset>`;
    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// NOTE: there used to be a `/public/:companySlug/robots.txt` route here. It was
// removed rather than fixed: robots.txt is only ever read from the origin root,
// so a per-company copy could never influence any crawler. Worse, now that
// /public/ is explicitly allowed above, it would have been fetched and indexed
// as an ordinary plain-text page. Per-company crawl rules are not a thing the
// protocol supports; the per-company *sitemaps* above are the real mechanism.

// The tenant for this request, bound from the authenticated session by the
// global auth gate. Never read from headers/query/body (those are spoofable).
function getCompanyId(req: any): number {
  const bound = req?.__tenantCompanyId;
  if (typeof bound === 'number' && Number.isInteger(bound)) return bound;
  throw new Error('No authenticated company for this request.');
}
// For installation-level endpoints that may run without a session (e.g. license
// activation): the session's company if there is one, otherwise null.
function getOptionalCompanyId(req: any): number | null {
  const bound = req?.__tenantCompanyId;
  return typeof bound === 'number' && Number.isInteger(bound) ? bound : null;
}

// ── AUTHENTICATION ─────────────────────────────────────────────────────

// 0. Check username availability
app.get('/api/auth/check-username', async (req, res) => {
  const { username } = req.query as { username: string };
  if (!username || username.length < 3) {
    return res.json({ available: false, reason: 'Username must be at least 3 characters.' });
  }
  try {
    const existing = await prisma.user.findUnique({ where: { username } });
    res.json({ available: !existing, reason: existing ? 'Username is already taken.' : 'Username is available!' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 0b. Register new company + admin user (30-day free trial)
app.post('/api/auth/register', async (req, res) => {
  const {
    companyName, industry, address, phone,
    country, currency, currencySymbol, timezone,
    firstName, lastName, email, username, password
  } = req.body;

  if (!companyName || !firstName || !lastName || !email || !username || !password) {
    return res.status(400).json({ error: 'All required fields must be filled.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  try {
    // Check uniqueness
    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] }
    });
    if (existingUser) {
      return res.status(409).json({ error: 'A user with that username or email already exists.' });
    }

    // Derive public slug from company name
    const slug = companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 80) + '-' + Date.now().toString().slice(-5);

    // Find or use free plan
    let freePlan = await prisma.subscriptionPlan.findFirst({ where: { planType: 'free' } });
    if (!freePlan) {
      freePlan = await prisma.subscriptionPlan.create({
        data: { name: 'Free Trial', planType: 'free', priceMonthly: 0, maxUsers: 3, maxItems: 50 }
      });
    }

    // Trial period: 30 days
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 30);

    // Create company
    const company = await prisma.company.create({
      data: {
        name: companyName,
        email,
        phone: phone || null,
        address: address || null,
        country: country || 'UG',
        currency: currency || 'UGX',
        currencySymbol: currencySymbol || currency || 'UGX',
        timezone: timezone || 'Africa/Kampala',
        industry: industry || 'Equipment Rental',
        planId: freePlan.id,
        publicSlug: slug,
        publicBookingsEnabled: true,
        trialActive: true,
        trialEndsAt,
        onboardingComplete: false
      },
      include: { plan: true }
    });

    // Create admin user (password hashed with bcrypt)
    const user = await prisma.user.create({
      data: {
        username,
        email,
        password: hashPassword(password),
        firstName,
        lastName,
        isActive: true,
        emailVerified: false
      }
    });

    // Seed this company's roles (built-in Administrator + starter Staff) and make
    // the signup user the Administrator.
    const adminRole = await prisma.companyRole.create({
      data: { companyId: company.id, name: 'Administrator', description: 'Full access to everything (built-in).',
        isSystemAdmin: true, permissions: fullAccess() as any },
    });
    await prisma.companyRole.create({
      data: { companyId: company.id, name: 'Staff', description: 'Day-to-day operations; no financials, settings, or team management.',
        isSystemAdmin: false, permissions: defaultStaffPermissions() as any },
    });

    // Create admin profile
    await prisma.userProfile.create({
      data: { userId: user.id, companyId: company.id, role: 'Admin', companyRoleId: adminRole.id }
    });

    // Issue a verification token and send the welcome / verify email.
    const verifyToken = await issueAuthToken(user.id, 'email_verification', 24 * 60 * 60 * 1000);
    await sendEmail(buildVerificationEmail(email, firstName, `${API_BASE}/api/auth/verify-email?token=${verifyToken}`));

    // Calculate trial days left
    const now = new Date();
    const trialDaysLeft = Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

    // Session token so the client can auto-sign-in the new admin.
    const sessionToken = await createSession(user.id);

    res.status(201).json({
      message: 'Account created successfully.',
      sessionToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: 'Admin',
        emailVerified: false,
        isSuperuser: false,
        isSystemAdmin: true,
        roleName: 'Administrator',
        companyRoleId: adminRole.id,
        permissions: fullAccess(),
      },
      company: {
        ...company,
        trialDaysLeft
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 1. Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  try {
    const user = await prisma.user.findUnique({
      where: { username }
    });

    if (!user || !passwordMatches(password, user.password)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    if (!user.isActive) {
      return res.status(403).json({ error: 'This account has been disabled. Contact your administrator.' });
    }
    // Opportunistically upgrade any legacy plaintext password to a bcrypt hash.
    if (!isBcryptHash(user.password)) {
      await prisma.user.update({ where: { id: user.id }, data: { password: hashPassword(password) } });
    }

    const profile = await prisma.userProfile.findUnique({
      where: { userId: user.id },
      include: {
        company: {
          include: {
            plan: true
          }
        },
        companyRole: true,
      }
    });

    // Calculate trial info
    let trialDaysLeft = 0;
    if (profile?.company?.trialEndsAt) {
      const now = new Date();
      trialDaysLeft = Math.max(0, Math.ceil(
        (new Date(profile.company.trialEndsAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      ));
    }

    // Block sign-in for tenants whose company has been suspended by a platform
    // admin (superusers are exempt — they have no company / manage the platform).
    if (!user.isSuperuser && profile?.company && !profile.company.isActive) {
      return res.status(403).json({ error: "Your organization's account has been suspended. Please contact support." });
    }

    const companyData = profile?.company
      ? { ...profile.company, trialDaysLeft }
      : null;

    // Superusers get a platform-admin session token for the super-admin console.
    const adminToken = user.isSuperuser ? issueAdminSession(user.id, user.username) : undefined;

    // Per-user session token — authoritative identity for permission enforcement.
    const sessionToken = await createSession(user.id);

    // Effective business permissions for UI gating (admins/system → full access).
    const isSystemAdmin = user.isSuperuser || profile?.role === 'Admin' || !!profile?.companyRole?.isSystemAdmin;
    const permissions = isSystemAdmin ? fullAccess() : sanitizeMatrix(profile?.companyRole?.permissions);

    res.json({
      sessionToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: profile?.role || 'User',
        emailVerified: user.emailVerified,
        isSuperuser: user.isSuperuser,
        isSystemAdmin,
        roleName: profile?.companyRole?.name || (profile?.role === 'Admin' ? 'Administrator' : 'Staff'),
        companyRoleId: profile?.companyRoleId || null,
        permissions,
      },
      company: companyData,
      adminToken,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Logout — invalidate the current session token.
app.post('/api/auth/logout', async (req, res) => {
  const token = req.headers?.['x-session-token'];
  if (typeof token === 'string' && token) await destroySession(token);
  res.json({ ok: true });
});

// ── EMAIL VERIFICATION & PASSWORD RESET ────────────────────────────────────

// Small self-contained HTML page (verification links in email open this directly).
function authResultPage(ok: boolean, title: string, message: string) {
  const color = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title></head>
  <body style="margin:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;">
    <div style="max-width:440px;background:#fff;border-radius:14px;border:1px solid #e2e8f0;overflow:hidden;text-align:center;">
      <div style="height:6px;background:${color};"></div>
      <div style="padding:36px 32px;">
        <h1 style="margin:0 0 6px;font-size:20px;color:#0f172a;">YourHires</h1>
        <div style="font-size:40px;margin:14px 0;">${ok ? '✅' : '⚠️'}</div>
        <h2 style="font-size:18px;color:${color};margin:0 0 8px;">${title}</h2>
        <p style="font-size:14px;color:#475569;">${message}</p>
        <a href="${CLIENT_URL}" style="display:inline-block;margin-top:18px;background:#2563eb;color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:10px 22px;border-radius:8px;">Go to YourHires</a>
      </div>
    </div>
  </body></html>`;
}

// Verify email — opened from the link in the verification email.
app.get('/api/auth/verify-email', async (req, res) => {
  const token = String(req.query.token || '');
  try {
    const record = await prisma.authToken.findUnique({ where: { token } });
    if (!record || record.purpose !== 'email_verification' || record.usedAt || record.expiresAt < new Date()) {
      return res.status(400).send(authResultPage(false, 'Link invalid or expired', 'Please request a new verification email from your account.'));
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } }),
      prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    res.send(authResultPage(true, 'Email verified', 'Your email address has been confirmed. You can now sign in.'));
  } catch (err: any) {
    res.status(500).send(authResultPage(false, 'Something went wrong', 'Please try again later.'));
  }
});

// Resend verification email
app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email: String(email || '') } });
    // Always report success (avoid leaking which emails exist).
    if (user && !user.emailVerified) {
      const token = await issueAuthToken(user.id, 'email_verification', 24 * 60 * 60 * 1000);
      await sendEmail(buildVerificationEmail(user.email, user.firstName || 'there', `${API_BASE}/api/auth/verify-email?token=${token}`));
    }
    res.json({ message: 'If that email is registered and unverified, a new verification link has been sent.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Request a password reset — emails a reset link to the client app.
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email: String(email || '') } });
    if (user) {
      const token = await issueAuthToken(user.id, 'password_reset', 60 * 60 * 1000);
      await sendEmail(buildPasswordResetEmail(user.email, user.firstName || 'there', `${CLIENT_URL}/?resetToken=${token}`));
    }
    res.json({ message: 'If that email is registered, a password reset link has been sent.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Complete a password reset with the emailed token.
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const record = await prisma.authToken.findUnique({ where: { token: String(token) } });
    if (!record || record.purpose !== 'password_reset' || record.usedAt || record.expiresAt < new Date()) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { password: hashPassword(String(password)) } }),
      prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    const user = await prisma.user.findUnique({ where: { id: record.userId }, include: { profile: true } });
    if (user?.profile?.companyId) {
      await logAudit(user.profile.companyId, user.username, 'PASSWORD_RESET', 'User', user.id, user.username, 'Password reset completed via emailed link.');
    }
    res.json({ message: 'Your password has been reset. You can now sign in with your new password.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Dev-only: inspect captured emails when no real SMTP is configured.
app.get('/api/auth/dev-emails', (req, res) => {
  res.json(devEmailLog.slice(-10).reverse());
});

// ── COMPANY USER / TEAM MANAGEMENT ─────────────────────────────────────────
// NOTE: passwords are stored/compared in plain text to match the existing auth
// pattern (seed + register). Hashing is deferred as a separate cross-cutting change.

const VALID_ROLES = ['Admin', 'User'];

function shapeUser(u: any) {
  return {
    id: u.id, username: u.username, email: u.email,
    firstName: u.firstName, lastName: u.lastName, isActive: u.isActive,
    role: u.profile?.role || 'User',
    isSuperuser: u.isSuperuser,
    companyRoleId: u.profile?.companyRoleId || null,
    roleName: u.profile?.companyRole?.name || (u.profile?.role === 'Admin' ? 'Administrator' : 'Staff'),
  };
}

// List all users belonging to the current company
app.get('/api/company/users', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const users = await prisma.user.findMany({
      where: { profile: { companyId } },
      include: { profile: { include: { companyRole: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users.map(shapeUser));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Resolve a requested companyRoleId (or legacy 'Admin'/'User' string) to a
// concrete CompanyRole for the given company, plus the coarse tier it implies.
async function resolveCompanyRole(companyId: number, companyRoleId: any, legacyRole?: string) {
  if (companyRoleId != null) {
    const role = await prisma.companyRole.findFirst({ where: { id: parseInt(companyRoleId), companyId } });
    if (role) return { role, coarse: role.isSystemAdmin ? 'Admin' : 'User' };
  }
  // Fallback to legacy tier → the matching built-in role.
  const wantAdmin = legacyRole === 'Admin';
  const role = wantAdmin
    ? await prisma.companyRole.findFirst({ where: { companyId, isSystemAdmin: true } })
    : await prisma.companyRole.findFirst({ where: { companyId, name: 'Staff' } });
  return { role: role || null, coarse: wantAdmin ? 'Admin' : 'User' };
}

// Add a team member to the current company (respects the plan's maxUsers cap)
app.post('/api/company/users', async (req, res) => {
  if (!(await requirePermission(req, res, 'team', 'manage'))) return;
  const companyId = getCompanyId(req);
  const { firstName, lastName, email, username, password, role, companyRoleId } = req.body;
  if (!firstName || !lastName || !email || !username || !password) {
    return res.status(400).json({ error: 'First name, last name, email, username and password are required.' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  try {
    const company = await prisma.company.findUnique({ where: { id: companyId }, include: { plan: true } });
    if (!company) return res.status(404).json({ error: 'Company not found.' });

    // Enforce plan seat limit
    const seatCount = await prisma.userProfile.count({ where: { companyId } });
    if (company.plan?.maxUsers != null && seatCount >= company.plan.maxUsers) {
      return res.status(403).json({ error: `Your ${company.plan.name} plan allows up to ${company.plan.maxUsers} users. Upgrade to add more team members.` });
    }

    const existing = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] } });
    if (existing) return res.status(409).json({ error: 'A user with that username or email already exists.' });

    const { role: resolvedRole, coarse } = await resolveCompanyRole(companyId, companyRoleId, role);

    const user = await prisma.user.create({
      data: { username, email, password: hashPassword(password), firstName, lastName, isActive: true,
        profile: { create: { companyId, role: coarse, companyRoleId: resolvedRole?.id ?? null } } },
      include: { profile: { include: { companyRole: true } } },
    });

    await logAudit(companyId, getActor(req), 'USER_ADDED', 'User', user.id, username,
      `Team member added: ${firstName} ${lastName} (${username}) as ${resolvedRole?.name || coarse}.`);

    res.status(201).json(shapeUser(user));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update a team member's role or active status (guards the last active admin)
app.patch('/api/company/users/:id', async (req, res) => {
  if (!(await requirePermission(req, res, 'team', 'manage'))) return;
  const companyId = getCompanyId(req);
  const userId = parseInt(req.params.id);
  const { role, isActive, companyRoleId } = req.body;
  try {
    const target = await prisma.user.findFirst({ where: { id: userId, profile: { companyId } }, include: { profile: true } });
    if (!target) return res.status(404).json({ error: 'User not found in this company.' });

    // Resolve the requested new role (if any) to know the resulting coarse tier.
    const roleChangeRequested = companyRoleId !== undefined || role !== undefined;
    let resolved: { role: any; coarse: string } | null = null;
    if (roleChangeRequested) resolved = await resolveCompanyRole(companyId, companyRoleId, role);

    const demoting = resolved !== null && resolved.coarse !== 'Admin' && target.profile?.role === 'Admin';
    const deactivating = isActive === false && target.isActive;
    if ((demoting || deactivating)) {
      // Ensure at least one other active Admin remains
      const otherActiveAdmins = await prisma.user.count({
        where: { id: { not: userId }, isActive: true, profile: { companyId, role: 'Admin' } },
      });
      if (otherActiveAdmins === 0) {
        return res.status(400).json({ error: 'This is the last active admin — assign another admin first.' });
      }
    }

    if (resolved) {
      await prisma.userProfile.update({ where: { userId }, data: { role: resolved.coarse, companyRoleId: resolved.role?.id ?? null } });
    }
    if (isActive !== undefined) {
      await prisma.user.update({ where: { id: userId }, data: { isActive: !!isActive } });
    }

    const updated = await prisma.user.findUnique({ where: { id: userId }, include: { profile: { include: { companyRole: true } } } });
    await logAudit(companyId, getActor(req), 'USER_UPDATED', 'User', userId, target.username,
      `Team member updated${resolved ? `, role → ${resolved.role?.name || resolved.coarse}` : ''}${isActive !== undefined ? `, active → ${isActive}` : ''}.`);
    res.json(shapeUser(updated));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Remove a team member (cannot remove the last active admin)
app.delete('/api/company/users/:id', async (req, res) => {
  if (!(await requirePermission(req, res, 'team', 'manage'))) return;
  const companyId = getCompanyId(req);
  const userId = parseInt(req.params.id);
  try {
    const target = await prisma.user.findFirst({ where: { id: userId, profile: { companyId } }, include: { profile: true } });
    if (!target) return res.status(404).json({ error: 'User not found in this company.' });

    if (target.profile?.role === 'Admin') {
      const otherActiveAdmins = await prisma.user.count({
        where: { id: { not: userId }, isActive: true, profile: { companyId, role: 'Admin' } },
      });
      if (otherActiveAdmins === 0) {
        return res.status(400).json({ error: 'Cannot remove the last active admin.' });
      }
    }

    await prisma.user.delete({ where: { id: userId } }); // cascades to profile
    await logAudit(companyId, getActor(req), 'USER_REMOVED', 'User', userId, target.username,
      `Team member removed: ${target.username}.`);
    res.json({ message: 'User removed.' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── ROLES & PERMISSIONS (tenant RBAC) ──────────────────────────────────────

// The permission catalog (modules + actions) that drives the matrix UI.
app.get('/api/permissions/catalog', (req, res) => {
  res.json({ modules: MODULES });
});

// List this company's roles (+ member counts).
app.get('/api/company/roles', async (req, res) => {
  if (!(await requirePermission(req, res, 'team', 'manage'))) return;
  const companyId = getCompanyId(req);
  try {
    const roles = await prisma.companyRole.findMany({
      where: { companyId },
      include: { _count: { select: { members: true } } },
      orderBy: [{ isSystemAdmin: 'desc' }, { name: 'asc' }],
    });
    res.json(roles.map(r => ({
      id: r.id, name: r.name, description: r.description,
      isSystemAdmin: r.isSystemAdmin,
      permissions: r.isSystemAdmin ? fullAccess() : sanitizeMatrix(r.permissions),
      memberCount: r._count.members,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create a custom role.
app.post('/api/company/roles', async (req, res) => {
  if (!(await requirePermission(req, res, 'team', 'manage'))) return;
  const companyId = getCompanyId(req);
  const { name, description, permissions } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'A role name is required.' });
  try {
    const dup = await prisma.companyRole.findFirst({ where: { companyId, name: String(name).trim() } });
    if (dup) return res.status(409).json({ error: 'A role with that name already exists.' });
    const role = await prisma.companyRole.create({
      data: { companyId, name: String(name).trim(), description: description || null,
        isSystemAdmin: false, permissions: sanitizeMatrix(permissions) as any },
    });
    await logAudit(companyId, getActor(req), 'ROLE_CREATED', 'CompanyRole', role.id, role.name, `Role created: ${role.name}.`);
    res.status(201).json({ id: role.id, name: role.name, description: role.description, isSystemAdmin: false, permissions: sanitizeMatrix(role.permissions), memberCount: 0 });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update a custom role's name/description/permissions. The built-in Administrator
// role is immutable (always full access).
app.patch('/api/company/roles/:id', async (req, res) => {
  if (!(await requirePermission(req, res, 'team', 'manage'))) return;
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { name, description, permissions } = req.body || {};
  try {
    const role = await prisma.companyRole.findFirst({ where: { id, companyId } });
    if (!role) return res.status(404).json({ error: 'Role not found.' });
    if (role.isSystemAdmin) return res.status(400).json({ error: 'The Administrator role has full access and cannot be edited.' });

    if (name && String(name).trim() && String(name).trim() !== role.name) {
      const dup = await prisma.companyRole.findFirst({ where: { companyId, name: String(name).trim(), id: { not: id } } });
      if (dup) return res.status(409).json({ error: 'A role with that name already exists.' });
    }

    const data: any = {};
    if (name && String(name).trim()) data.name = String(name).trim();
    if (description !== undefined) data.description = description || null;
    if (permissions !== undefined) data.permissions = sanitizeMatrix(permissions) as any;

    const updated = await prisma.companyRole.update({ where: { id }, data, include: { _count: { select: { members: true } } } });
    await logAudit(companyId, getActor(req), 'ROLE_UPDATED', 'CompanyRole', id, updated.name, `Role updated: ${updated.name}.`);
    res.json({ id: updated.id, name: updated.name, description: updated.description, isSystemAdmin: false, permissions: sanitizeMatrix(updated.permissions), memberCount: updated._count.members });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a custom role (blocked if in use or if it's the built-in Administrator).
app.delete('/api/company/roles/:id', async (req, res) => {
  if (!(await requirePermission(req, res, 'team', 'manage'))) return;
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const role = await prisma.companyRole.findFirst({ where: { id, companyId }, include: { _count: { select: { members: true } } } });
    if (!role) return res.status(404).json({ error: 'Role not found.' });
    if (role.isSystemAdmin) return res.status(400).json({ error: 'The built-in Administrator role cannot be deleted.' });
    if (role._count.members > 0) return res.status(400).json({ error: `This role is assigned to ${role._count.members} user(s). Reassign them first.` });

    await prisma.companyRole.delete({ where: { id } });
    await logAudit(companyId, getActor(req), 'ROLE_DELETED', 'CompanyRole', id, role.name, `Role deleted: ${role.name}.`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 2. Fetch companies
app.get('/api/companies', async (req, res) => {
  try {
    // Only the caller's own company: other tenants' records are not theirs to see.
    const list = await prisma.company.findMany({ where: { id: getCompanyId(req) } });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update business settings (fee policy, payment terms, currency). Admin-only in UI.
app.patch('/api/companies/:id/settings', async (req, res) => {
  const id = parseInt(req.params.id);
  const {
    currency, currencySymbol, defaultPaymentTermsDays,
    lateFeePercentPerDay, damageFeePercent, lostFeePercent, restockReturnedItems,
    pricesIncludeTax
  } = req.body;

  // Clamp percentages to a sane range so a typo can't create an absurd charge.
  const pct = (v: any, fallback: number) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (isNaN(n)) return undefined;
    return Math.min(1000, Math.max(0, n));
  };

  try {
    const data: any = {};
    if (currency !== undefined) data.currency = currency;
    if (currencySymbol !== undefined) data.currencySymbol = currencySymbol;
    if (defaultPaymentTermsDays !== undefined && !isNaN(Number(defaultPaymentTermsDays))) {
      data.defaultPaymentTermsDays = Math.max(0, parseInt(defaultPaymentTermsDays));
    }
    const lf = pct(lateFeePercentPerDay, 10); if (lf !== undefined) data.lateFeePercentPerDay = lf;
    const df = pct(damageFeePercent, 50); if (df !== undefined) data.damageFeePercent = df;
    const lo = pct(lostFeePercent, 100); if (lo !== undefined) data.lostFeePercent = lo;
    if (restockReturnedItems !== undefined) data.restockReturnedItems = !!restockReturnedItems;
    if (pricesIncludeTax !== undefined) data.pricesIncludeTax = !!pricesIncludeTax;

    const company = await prisma.company.update({ where: { id }, data });

    await logAudit(id, getActor(req), 'SETTINGS_UPDATED', 'Company', id, company.name,
      `Business settings updated. Late fee/day: ${company.lateFeePercentPerDay}%, Damage fee: ${company.damageFeePercent}%, Lost fee: ${company.lostFeePercent}%, Restock returns: ${company.restockReturnedItems}, Terms: Net ${company.defaultPaymentTermsDays}.`);

    res.json(company);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── CUSTOMERS ──────────────────────────────────────────────────────────

// 2b. Fetch all customers (with rental order count and watchlist status)
app.get('/api/customers', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.customer.findMany({
      where: { companyId },
      include: {
        _count: { select: { rentalOrders: true, bookings: true } }
      },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2c. Create customer
app.post('/api/customers', async (req, res) => {
  const { companyId, name, contactInfo, taxId } = req.body;
  if (!companyId || !name) {
    return res.status(400).json({ error: 'companyId and name are required.' });
  }
  try {
    const customer = await prisma.customer.create({
      data: {
        companyId: parseInt(companyId),
        name,
        contactInfo: contactInfo || '',
        isOnWatchList: false,
        // A TIN turns this customer's invoices into B2B ones at URA.
        taxId: taxId?.trim() || null
      }
    });
    audit(req, 'CREATE', 'Customer', customer.id, customer.name, `Customer created: ${customer.name}.`);
    res.status(201).json(customer);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 2d. Toggle watchlist for a customer
// Set or clear a customer's TIN. A TIN makes their invoices B2B at URA, so it is
// worth being able to add one to a customer created before they gave it.
app.patch('/api/customers/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { name, contactInfo, taxId } = req.body;
  try {
    const existing = await prisma.customer.findFirst({ where: { id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Customer not found.' });

    const data: any = {};
    if (name !== undefined) data.name = name;
    if (contactInfo !== undefined) data.contactInfo = contactInfo || '';
    if (taxId !== undefined) data.taxId = taxId?.trim() || null;

    const updated = await prisma.customer.update({ where: { id }, data });
    audit(req, 'UPDATE', 'Customer', id, updated.name,
      `Customer updated: ${updated.name}${taxId !== undefined ? ` (TIN ${updated.taxId || 'cleared'})` : ''}.`);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/customers/:id/watchlist', async (req, res) => {
  const { id } = req.params;
  const { isOnWatchList, watchListReason } = req.body;
  try {
    const updated = await prisma.customer.update({
      where: { id: parseInt(id) },
      data: { isOnWatchList, watchListReason: watchListReason || null }
    });
    audit(req, isOnWatchList ? 'WATCHLIST_ADD' : 'WATCHLIST_REMOVE', 'Customer', updated.id, updated.name,
      isOnWatchList ? `Added to watchlist${watchListReason ? ': ' + watchListReason : ''}.` : 'Removed from watchlist.');
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 2e. Get full rental history for a customer
app.get('/api/customers/:id/history', async (req, res) => {
  const { id } = req.params;
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: parseInt(id) },
      include: {
        rentalOrders: { orderBy: { checkoutDate: 'desc' }, take: 20 },
        bookings: { orderBy: { bookingDate: 'desc' }, take: 10 }
      }
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(customer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── CUSTOMER ACCOUNTS & LEDGER ENDPOINTS ─────────────────────────────────

// Fetch all customer accounts with customer names & outstanding balances
app.get('/api/customer-accounts', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const customers = await prisma.customer.findMany({
      where: { companyId },
      include: { account: true }
    });

    // Make sure every customer has an account
    const list = [];
    for (const customer of customers) {
      const account = await getOrCreateCustomerAccount(customer.id, companyId);
      list.push({
        ...account,
        customerName: customer.name,
        isOnWatchList: customer.isOnWatchList
      });
    }

    // Sort by outstanding balance descending
    list.sort((a, b) => Number(b.totalOutstanding) - Number(a.totalOutstanding));
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch detailed account info, settings, and transaction log for a customer
app.get('/api/customer-accounts/:customerId', async (req, res) => {
  const companyId = getCompanyId(req);
  const customerId = parseInt(req.params.customerId);
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId }
    });
    if (!customer || customer.companyId !== companyId) {
      return res.status(404).json({ error: 'Customer not found.' });
    }

    const account = await getOrCreateCustomerAccount(customerId, companyId);

    const transactions = await prisma.customerAccountTransaction.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      account,
      customerName: customer.name,
      contactInfo: customer.contactInfo,
      transactions
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update settings (credit limit, payment terms, tax ID)
app.put('/api/customer-accounts/:customerId', async (req, res) => {
  const companyId = getCompanyId(req);
  const customerId = parseInt(req.params.customerId);
  const { creditLimit, paymentTermsDays, taxId } = req.body;
  try {
    const account = await getOrCreateCustomerAccount(customerId, companyId);

    const updated = await prisma.customerAccount.update({
      where: { id: account.id },
      data: {
        creditLimit: creditLimit !== undefined ? Number(creditLimit) : account.creditLimit,
        paymentTermsDays: paymentTermsDays !== undefined ? parseInt(paymentTermsDays) : account.paymentTermsDays,
        // taxId is a string, let's verify if taxId exists on schema. prisma.customerAccount has no taxId in schema?
        // Let's check schema: CustomerAccount only has creditLimit, paymentTermsDays, totalOutstanding, etc.
        // It has no taxId. We will skip taxId or keep it in Customer.contactInfo.
      }
    });

    await recalculateCustomerBalance(customerId, companyId);

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Post a manual transaction adjustment / refund
app.post('/api/customer-accounts/:customerId/transactions', async (req, res) => {
  const companyId = getCompanyId(req);
  const customerId = parseInt(req.params.customerId);
  const { transactionType, amount, description, referenceNumber, dueDate } = req.body;

  if (!transactionType || amount === undefined || !description) {
    return res.status(400).json({ error: 'transactionType, amount, and description are required.' });
  }

  try {
    const account = await getOrCreateCustomerAccount(customerId, companyId);

    const tx = await createAccountTransaction({
      customerId,
      companyId,
      transactionType,
      amount: Number(amount),
      description,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      referenceNumber: referenceNumber || makeReference('ADJ')
    });

    if (Number(amount) < 0) {
      await recordIncome({
        companyId,
        incomeSource: transactionType === 'booking_deposit' ? 'booking_deposit' : 'invoice_payment',
        amount: Math.abs(Number(amount)),
        paymentMethod: 'cash',
        referenceNumber: tx.referenceNumber || undefined,
        description: `${description} (Customer Account Credit Adjustment)`
      });
    }

    audit(req, 'LEDGER_TXN', 'CustomerAccount', customerId, tx.referenceNumber || description,
      `Ledger ${Number(amount) < 0 ? 'credit' : 'debit'} of ${Math.abs(Number(amount)).toLocaleString()} (${transactionType}) — ${description}.`);
    res.status(201).json(tx);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Run a complete recalculation and backfill of all accounts from historical database records
app.post('/api/customer-accounts/recalculate', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const customers = await prisma.customer.findMany({
      where: { companyId }
    });

    let processedCount = 0;
    let transactionsCount = 0;

    for (const customer of customers) {
      const account = await getOrCreateCustomerAccount(customer.id, companyId);

      // Clear existing transactions to allow a fresh clean rebuild/backfill
      await prisma.customerAccountTransaction.deleteMany({
        where: { accountId: account.id }
      });

      // 1. Backfill from Rental Orders (debits & payments)
      const rentalOrders = await prisma.rentalOrder.findMany({
        where: { customerId: customer.id }
      });

      for (const order of rentalOrders) {
        const orderNum = order.companyOrderNumber;
        const checkoutDate = order.checkoutDate;

        // Debit: Base Rental Amount
        await prisma.customerAccountTransaction.create({
          data: {
            accountId: account.id,
            transactionType: 'invoice',
            amount: order.estimatedTotal,
            balanceAfterTransaction: 0,
            description: `Rental Order #${orderNum}`,
            referenceNumber: orderNum,
            createdAt: checkoutDate
          }
        });
        transactionsCount++;

        // Debit: Late Fee (if exists)
        if (Number(order.totalLateFeeCalculated) > 0) {
          await prisma.customerAccountTransaction.create({
            data: {
              accountId: account.id,
              transactionType: 'late_fee',
              amount: order.totalLateFeeCalculated,
              balanceAfterTransaction: 0,
              description: `Late return penalty on Order #${orderNum}`,
              referenceNumber: `${orderNum}-LF`,
              createdAt: order.actualReturnDate || checkoutDate
            }
          });
          transactionsCount++;
        }

        // Debit: Damage/Replacement Fee (if exists)
        if (Number(order.totalReplacementFeeCalculated) > 0) {
          await prisma.customerAccountTransaction.create({
            data: {
              accountId: account.id,
              transactionType: 'damage_fee',
              amount: order.totalReplacementFeeCalculated,
              balanceAfterTransaction: 0,
              description: `Damage/replacement charges on Order #${orderNum}`,
              referenceNumber: `${orderNum}-DF`,
              createdAt: order.actualReturnDate || checkoutDate
            }
          });
          transactionsCount++;
        }

        // Credit: Total Amount Paid (e.g. deposit or partial cash payment recorded on order)
        if (Number(order.totalAmountPaid) > 0) {
          await prisma.customerAccountTransaction.create({
            data: {
              accountId: account.id,
              transactionType: 'payment',
              amount: -Number(order.totalAmountPaid), // Credit
              balanceAfterTransaction: 0,
              description: `Payment/Deposit on Order #${orderNum}`,
              referenceNumber: `${orderNum}-PAY`,
              createdAt: checkoutDate
            }
          });
          transactionsCount++;
        }
      }

      // 2. Backfill from Booking deposits (only for bookings that were not converted to orders)
      const bookings = await prisma.booking.findMany({
        where: {
          customerId: customer.id,
          depositPaid: true,
          status: { not: 'converted' }
        }
      });

      for (const booking of bookings) {
        if (Number(booking.depositAmount) > 0) {
          await prisma.customerAccountTransaction.create({
            data: {
              accountId: account.id,
              transactionType: 'booking_deposit',
              amount: -Number(booking.depositAmount), // Credit
              balanceAfterTransaction: 0,
              description: `Booking Deposit - ${booking.bookingNumber}`,
              referenceNumber: booking.bookingNumber,
              createdAt: booking.depositPaidDate || booking.bookingDate
            }
          });
          transactionsCount++;
        }
      }

      // 3. Backfill invoice payments (cash only — deposits were credited above
      //    via the order, and credit notes are handled separately below).
      //    Scoped to this company: customer names are not unique across tenants.
      const invoices = await prisma.invoice.findMany({
        where: { companyId, OR: [{ customerId: customer.id }, { customerId: null, customerName: customer.name }] },
        include: { payments: true, rentalOrder: { select: { totalAmountPaid: true } } },
      });

      for (const invoice of invoices) {
        const rows = invoice.payments.length
          ? invoice.payments.map(p => ({ amount: Number(p.amount), at: p.paymentDate, ref: `${invoice.referenceNumber}-PAY${p.id}`, method: p.paymentMethod }))
          : (() => {
              // Legacy invoices (before payment records): cash = amountPaid less
              // any deposit applied at dispatch.
              const deposit = invoice.invoiceType === 'RENTAL' ? Number(invoice.rentalOrder?.totalAmountPaid || 0) : 0;
              const cash = round2(Number(invoice.amountPaid) - deposit);
              return cash > 0 && invoice.paymentDate
                ? [{ amount: cash, at: invoice.paymentDate, ref: invoice.referenceNumber, method: invoice.paymentMethod || 'Cash' }]
                : [];
            })();
        for (const r of rows) {
          await prisma.customerAccountTransaction.create({
            data: {
              accountId: account.id,
              transactionType: 'payment',
              amount: -r.amount, // Credit
              balanceAfterTransaction: 0,
              description: `Invoice Payment - ${invoice.referenceNumber} (${r.method})`,
              referenceNumber: r.ref,
              createdAt: r.at
            }
          });
          transactionsCount++;
        }
      }

      // 4. Backfill from Credit Notes (credit memo adjustment)
      const creditNotes = await prisma.creditNote.findMany({
        where: { companyId, OR: [{ customerId: customer.id }, { customerId: null, customerName: customer.name }] }
      });

      for (const note of creditNotes) {
        await prisma.customerAccountTransaction.create({
          data: {
            accountId: account.id,
            transactionType: 'credit_memo',
            amount: -Number(note.amount), // Credit
            balanceAfterTransaction: 0,
            description: `Credit Memo - ${note.referenceNumber} (${note.reason})`,
            referenceNumber: note.referenceNumber,
            createdAt: note.createdAt
          }
        });
        transactionsCount++;
      }

      // Re-run the balance distribution & aging bucketing
      await recalculateCustomerBalance(customer.id, companyId);
      processedCount++;
    }

    res.json({
      message: 'Recalculation and backfill completed successfully.',
      processedCustomers: processedCount,
      recreatedTransactions: transactionsCount
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── ASSET MAINTENANCE, EVENTS RESERVATIONS, & OPERATIONS ──────────────────

// Fetch maintenance log for an asset
app.get('/api/serialized-assets/:assetId/maintenance', async (req, res) => {
  const companyId = getCompanyId(req);
  const assetId = parseInt(req.params.assetId);
  try {
    const list = await prisma.maintenanceEvent.findMany({
      where: { companyId, assetId },
      orderBy: { startTime: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create/Schedule a maintenance event
app.post('/api/serialized-assets/:assetId/maintenance', async (req, res) => {
  const companyId = getCompanyId(req);
  const assetId = parseInt(req.params.assetId);
  const { title, description, startTime, endTime, status, cost, notes } = req.body;

  if (!title || !startTime || !endTime) {
    return res.status(400).json({ error: 'title, startTime, and endTime are required.' });
  }

  try {
    const asset = await prisma.serializedAsset.findUnique({
      where: { id: assetId }
    });
    if (!asset || asset.companyId !== companyId) {
      return res.status(404).json({ error: 'Asset not found.' });
    }

    const event = await prisma.maintenanceEvent.create({
      data: {
        companyId,
        assetId,
        title,
        description: description || '',
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        status: status || 'Scheduled',
        cost: cost ? Number(cost) : 0.00,
        notes: notes || ''
      }
    });

    // If status is in_progress, mark asset as in Maintenance
    if (status === 'in_progress') {
      await prisma.serializedAsset.update({
        where: { id: assetId },
        data: { status: 'Maintenance' }
      });
    }

    res.status(201).json(event);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Complete a maintenance event
app.post('/api/maintenance-events/:id/complete', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { cost, notes } = req.body;
  try {
    const event = await prisma.maintenanceEvent.findUnique({
      where: { id }
    });
    if (!event || event.companyId !== companyId) {
      return res.status(404).json({ error: 'Maintenance event not found.' });
    }

    const updated = await prisma.maintenanceEvent.update({
      where: { id },
      data: {
        status: 'Completed',
        cost: cost !== undefined ? Number(cost) : event.cost,
        notes: notes !== undefined ? notes : event.notes
      }
    });

    // Update asset status back to Available
    await prisma.serializedAsset.update({
      where: { id: event.assetId },
      data: { status: 'Available' }
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch items/assets reserved for an event
app.get('/api/functions/:functionId/items', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  try {
    const list = await prisma.functionItemAssignment.findMany({
      where: { companyId, functionId },
      include: {
        item: true,
        asset: true,
        consumable: {
          include: {
            packageUnit: true,
            pieceUnit: true,
            unitOfMeasure: true
          }
        },
        unitOfMeasure: true
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Reserve item or asset for an event
app.post('/api/functions/:functionId/items', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { itemType, itemId, assetId, consumableId, unitOfMeasureId, quantity, notes } = req.body;

  if (!itemType || (itemType === 'item' && !itemId) || (itemType === 'asset' && !assetId) || (itemType === 'consumable' && !consumableId)) {
    return res.status(400).json({ error: 'itemType, and itemId/assetId/consumableId are required.' });
  }

  try {
    const func = await prisma.functionEvent.findUnique({
      where: { id: functionId }
    });
    if (!func || func.companyId !== companyId) {
      return res.status(404).json({ error: 'Function not found.' });
    }

    if (itemType === 'asset') {
      const asset = await prisma.serializedAsset.findUnique({
        where: { id: parseInt(assetId) }
      });
      if (!asset || asset.companyId !== companyId) {
        return res.status(404).json({ error: 'Asset not found.' });
      }
      if (asset.status !== 'Available') {
        return res.status(400).json({ error: `Asset is currently ${asset.status} and cannot be reserved.` });
      }

      // Check if already reserved for this function
      const exists = await prisma.functionItemAssignment.findFirst({
        where: { functionId, assetId: asset.id, status: { not: 'cancelled' } }
      });
      if (exists) {
        return res.status(400).json({ error: 'Asset is already reserved for this event.' });
      }
    } else if (itemType === 'consumable') {
      const consumable = await prisma.consumable.findUnique({
        where: { id: parseInt(consumableId) }
      });
      if (!consumable || consumable.companyId !== companyId) {
        return res.status(404).json({ error: 'Consumable not found.' });
      }
    } else {
      const item = await prisma.item.findUnique({
        where: { id: parseInt(itemId) }
      });
      if (!item || item.companyId !== companyId) {
        return res.status(404).json({ error: 'Item not found.' });
      }
    }

    const assignment = await prisma.functionItemAssignment.create({
      data: {
        companyId,
        functionId,
        itemType,
        itemId: itemId ? parseInt(itemId) : null,
        assetId: assetId ? parseInt(assetId) : null,
        consumableId: consumableId ? parseInt(consumableId) : null,
        unitOfMeasureId: unitOfMeasureId ? parseInt(unitOfMeasureId) : null,
        quantity: itemType === 'asset' ? 1 : parseInt(quantity) || 1,
        notes: notes || '',
        status: 'booked'
      },
      include: {
        item: true,
        asset: true,
        consumable: {
          include: {
            packageUnit: true,
            pieceUnit: true,
            unitOfMeasure: true
          }
        },
        unitOfMeasure: true
      }
    });

    const name = assignment.item?.name || assignment.asset?.name || assignment.consumable?.name || '';
    const uomAbbrev = assignment.unitOfMeasure?.abbreviation || '';
    const qtyLabel = uomAbbrev ? `${assignment.quantity} ${uomAbbrev}` : `${assignment.quantity}`;
    await prisma.functionActivity.create({
      data: {
        companyId,
        functionId,
        activityType: 'note_added',
        description: `Reserved ${itemType === 'asset' ? 'asset' : itemType === 'consumable' ? 'consumable' : 'item'}: ${name} (Qty: ${qtyLabel})`
      }
    });

    res.status(201).json(assignment);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Cancel reservation
app.delete('/api/function-items/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const assignment = await prisma.functionItemAssignment.findUnique({
      where: { id },
      include: { item: true, asset: true }
    });
    if (!assignment || assignment.companyId !== companyId) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    // If dispatched, restore stock/status first
    if (assignment.status === 'dispatched') {
      if (assignment.itemType === 'asset' && assignment.assetId) {
        await prisma.serializedAsset.update({
          where: { id: assignment.assetId },
          data: { status: 'Available' }
        });
      } else if (assignment.itemType === 'item' && assignment.itemId) {
        await prisma.item.update({
          where: { id: assignment.itemId },
          data: { currentStock: { increment: assignment.quantity } }
        });
      }
    }

    await prisma.functionItemAssignment.delete({
      where: { id }
    });

    const name = assignment.item?.name || assignment.asset?.name || '';
    await prisma.functionActivity.create({
      data: {
        companyId,
        functionId: assignment.functionId,
        activityType: 'note_added',
        description: `Cancelled reservation for ${name}`
      }
    });

    audit(req, 'DELETE', 'FunctionItemAssignment', id, name || String(id),
      `Event reservation cancelled: ${name || `#${id}`} (qty ${assignment.quantity}).`);
    res.json({ message: 'Reservation cancelled successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Dispatch reservation (marks dispatched, updates stock/asset status)
app.post('/api/function-items/:id/dispatch', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const assignment = await prisma.functionItemAssignment.findUnique({
      where: { id },
      include: { item: true, asset: true }
    });
    if (!assignment || assignment.companyId !== companyId) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    if (assignment.status !== 'booked') {
      return res.status(400).json({ error: `Cannot dispatch item with status ${assignment.status}` });
    }

    const updated = await prisma.functionItemAssignment.update({
      where: { id },
      data: {
        status: 'dispatched',
        dispatchedAt: new Date()
      }
    });

    if (assignment.itemType === 'asset' && assignment.assetId) {
      await prisma.serializedAsset.update({
        where: { id: assignment.assetId },
        data: { status: 'Rented' }
      });
    } else if (assignment.itemType === 'item' && assignment.itemId) {
      await prisma.item.update({
        where: { id: assignment.itemId },
        data: { currentStock: { decrement: assignment.quantity } }
      });
    } else if (assignment.itemType === 'consumable' && assignment.consumableId) {
      const consumable = await prisma.consumable.findUnique({
        where: { id: assignment.consumableId }
      });
      if (!consumable) throw new Error('Consumable not found.');
      
      const baseQty = (consumable.isMultiUnit && assignment.unitOfMeasureId && assignment.unitOfMeasureId === consumable.packageUnitId)
        ? assignment.quantity * consumable.unitRatio
        : assignment.quantity;

      if (consumable.stockQty < baseQty) {
        throw new Error(`Insufficient stock. Available: ${consumable.stockQty}, Required: ${baseQty}`);
      }

      await prisma.consumable.update({
        where: { id: assignment.consumableId },
        data: { stockQty: { decrement: baseQty } }
      });

      await prisma.consumableLog.create({
        data: {
          consumableId: assignment.consumableId,
          action: 'use',
          quantity: baseQty,
          operator: 'system',
          notes: `Used in event Ceremony load-out (Assignment #${assignment.id})`
        }
      });

      // Record Expense
      const totalCost = Number(consumable.costPrice) * baseQty;
      if (totalCost > 0) {
        await prisma.expense.create({
          data: {
            companyId,
            amount: totalCost,
            expenseCategory: 'Event Setup Expenses',
            expenseDate: new Date().toISOString().split('T')[0],
            paymentMethod: 'internal',
            notes: `Event Setup Cost: ${assignment.quantity} x ${consumable.name} (Ceremony: Function #${assignment.functionId})`
          }
        });
      }
    }

    const name = assignment.item?.name || assignment.asset?.name || '';
    await prisma.functionActivity.create({
      data: {
        companyId,
        functionId: assignment.functionId,
        activityType: 'item_dispatched',
        description: `Dispatched ${name} (Qty: ${assignment.quantity})`
      }
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Return reservation (marks returned, restores stock/asset status)
app.post('/api/function-items/:id/return', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const assignment = await prisma.functionItemAssignment.findUnique({
      where: { id },
      include: { item: true, asset: true }
    });
    if (!assignment || assignment.companyId !== companyId) {
      return res.status(404).json({ error: 'Reservation not found.' });
    }

    if (assignment.status !== 'dispatched') {
      return res.status(400).json({ error: `Cannot return item with status ${assignment.status}` });
    }

    const updated = await prisma.functionItemAssignment.update({
      where: { id },
      data: {
        status: 'returned',
        returnedAt: new Date()
      }
    });

    if (assignment.itemType === 'asset' && assignment.assetId) {
      await prisma.serializedAsset.update({
        where: { id: assignment.assetId },
        data: { status: 'Available' }
      });
    } else if (assignment.itemType === 'item' && assignment.itemId) {
      await prisma.item.update({
        where: { id: assignment.itemId },
        data: { currentStock: { increment: assignment.quantity } }
      });
    } else if (assignment.itemType === 'consumable' && assignment.consumableId) {
      const consumable = await prisma.consumable.findUnique({
        where: { id: assignment.consumableId }
      });
      if (!consumable) throw new Error('Consumable not found.');
      
      const baseQty = (consumable.isMultiUnit && assignment.unitOfMeasureId && assignment.unitOfMeasureId === consumable.packageUnitId)
        ? assignment.quantity * consumable.unitRatio
        : assignment.quantity;

      await prisma.consumable.update({
        where: { id: assignment.consumableId },
        data: { stockQty: { increment: baseQty } }
      });

      await prisma.consumableLog.create({
        data: {
          consumableId: assignment.consumableId,
          action: 'restock',
          quantity: baseQty,
          operator: 'system',
          notes: `Returned unused from event Ceremony (Assignment #${assignment.id})`
        }
      });

      // Record a Reversal Expense (Negative Expense to offset the COGS)
      const totalCost = Number(consumable.costPrice) * baseQty;
      if (totalCost > 0) {
        await prisma.expense.create({
          data: {
            companyId,
            amount: -totalCost,
            expenseCategory: 'Event Setup Expenses',
            expenseDate: new Date().toISOString().split('T')[0],
            paymentMethod: 'internal',
            notes: `Event Cost Reversal: Returned unused ${assignment.quantity} x ${consumable.name}`
          }
        });
      }
    }

    const name = assignment.item?.name || assignment.asset?.name || '';
    await prisma.functionActivity.create({
      data: {
        companyId,
        functionId: assignment.functionId,
        activityType: 'item_returned',
        description: `Returned ${name} (Qty: ${assignment.quantity})`
      }
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch checklist items for an event
app.get('/api/functions/:functionId/checklist', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  try {
    const list = await prisma.functionChecklistItem.findMany({
      where: { companyId, functionId },
      include: { assignedEmployee: true },
      orderBy: { id: 'asc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Add checklist item
app.post('/api/functions/:functionId/checklist', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { itemText, notes, assignedEmployeeId } = req.body;

  if (!itemText) {
    return res.status(400).json({ error: 'itemText is required.' });
  }

  try {
    const item = await prisma.functionChecklistItem.create({
      data: {
        companyId,
        functionId,
        itemText,
        notes: notes || '',
        isCompleted: false,
        assignedEmployeeId: assignedEmployeeId ? parseInt(assignedEmployeeId) : null
      },
      include: { assignedEmployee: true }
    });
    res.status(201).json(item);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Toggle checklist completion status
app.put('/api/checklist-items/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { isCompleted } = req.body;
  try {
    const item = await prisma.functionChecklistItem.findUnique({
      where: { id }
    });
    if (!item || item.companyId !== companyId) {
      return res.status(404).json({ error: 'Checklist item not found.' });
    }

    const updated = await prisma.functionChecklistItem.update({
      where: { id },
      data: {
        isCompleted: Boolean(isCompleted),
        completedAt: isCompleted ? new Date() : null
      },
      include: { assignedEmployee: true }
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch reported issues for an event
app.get('/api/functions/:functionId/issues', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  try {
    const list = await prisma.functionIssue.findMany({
      where: { companyId, functionId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Log event issue
app.post('/api/functions/:functionId/issues', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { title, description, severity } = req.body;

  if (!title || !description) {
    return res.status(400).json({ error: 'title and description are required.' });
  }

  try {
    const issue = await prisma.functionIssue.create({
      data: {
        companyId,
        functionId,
        title,
        description,
        severity: severity || 'Medium',
        status: 'Reported'
      }
    });

    await prisma.functionActivity.create({
      data: {
        companyId,
        functionId,
        activityType: 'issue_reported',
        description: `⚠️ [${issue.severity}] Issue reported: "${issue.title}"`
      }
    });

    res.status(201).json(issue);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update issue (status/resolution notes)
app.put('/api/issues/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { status, resolutionNotes } = req.body;
  try {
    const issue = await prisma.functionIssue.findUnique({
      where: { id }
    });
    if (!issue || issue.companyId !== companyId) {
      return res.status(404).json({ error: 'Issue not found.' });
    }

    const updated = await prisma.functionIssue.update({
      where: { id },
      data: {
        status: status || issue.status,
        resolutionNotes: resolutionNotes !== undefined ? resolutionNotes : issue.resolutionNotes
      }
    });

    if (status === 'Resolved') {
      await prisma.functionActivity.create({
        data: {
          companyId,
          functionId: issue.functionId,
          activityType: 'issue_resolved',
          description: `✅ Issue resolved: "${issue.title}"`
        }
      });
    }

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch activity timeline for an event
app.get('/api/functions/:functionId/activities', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  try {
    const list = await prisma.functionActivity.findMany({
      where: { companyId, functionId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Post a manual timeline note
app.post('/api/functions/:functionId/activities', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { description } = req.body;

  if (!description) {
    return res.status(400).json({ error: 'description is required.' });
  }

  try {
    const note = await prisma.functionActivity.create({
      data: {
        companyId,
        functionId,
        activityType: 'note_added',
        description
      }
    });
    res.status(201).json(note);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── FUNCTION EXPENSES ────────────────────────────────────────────────────
app.get('/api/functions/:functionId/expenses', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  try {
    const list = await prisma.functionExpense.findMany({
      where: { companyId, functionId },
      orderBy: { id: 'desc' },
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/functions/:functionId/expenses', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { expenseType, description, amount, expenseDate, receiptNumber, notes } = req.body;
  if (!description || amount === undefined || !expenseDate) {
    return res.status(400).json({ error: 'description, amount, and expenseDate are required.' });
  }
  try {
    const expense = await prisma.functionExpense.create({
      data: {
        companyId, functionId,
        expenseType: expenseType || 'other',
        description, amount: Number(amount), expenseDate,
        receiptNumber: receiptNumber || null, notes: notes || null,
      }
    });

    // Recompute the function's total_expenses aggregate (mirrors the original's approach).
    const agg = await prisma.functionExpense.aggregate({ where: { functionId }, _sum: { amount: true } });
    await prisma.functionEvent.update({ where: { id: functionId }, data: { totalExpenses: agg._sum.amount || 0 } });

    await prisma.functionActivity.create({
      data: { companyId, functionId, activityType: 'expense_recorded', description: `Expense recorded: ${description} (${Number(amount).toLocaleString()})` }
    });

    res.status(201).json(expense);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/function-expenses/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const expense = await prisma.functionExpense.findFirst({ where: { id, companyId } });
    if (!expense) return res.status(404).json({ error: 'Expense not found.' });

    await prisma.functionExpense.delete({ where: { id } });
    const agg = await prisma.functionExpense.aggregate({ where: { functionId: expense.functionId }, _sum: { amount: true } });
    await prisma.functionEvent.update({ where: { id: expense.functionId }, data: { totalExpenses: agg._sum.amount || 0 } });

    await prisma.functionActivity.create({
      data: { companyId, functionId: expense.functionId, activityType: 'other', description: `Expense removed: ${expense.description}` }
    });

    audit(req, 'DELETE', 'FunctionExpense', id, expense.description,
      `Event expense removed: ${expense.description} (${Number(expense.amount).toLocaleString()}).`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── FUNCTION REVENUE ─────────────────────────────────────────────────────
// Recording revenue also posts to the consolidated Income ledger (source: function_fee),
// matching the original system's behavior of keeping per-function P&L and company-wide
// revenue reporting in sync.
app.post('/api/functions/:functionId/revenue', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { amount, paymentMethod, paymentDate, referenceNumber, notes } = req.body;
  if (amount === undefined || Number(amount) <= 0) {
    return res.status(400).json({ error: 'A positive amount is required.' });
  }
  try {
    const func = await prisma.functionEvent.findFirst({ where: { id: functionId, companyId } });
    if (!func) return res.status(404).json({ error: 'Function not found.' });

    const now = new Date();
    const updated = await prisma.functionEvent.update({
      where: { id: functionId },
      data: {
        totalRevenue: { increment: Number(amount) },
        revenuePaid: true,
        revenuePaidDate: func.revenuePaidDate || now,
      }
    });

    await recordIncome({
      companyId, incomeSource: 'function_fee', amount: Number(amount),
      paymentMethod: paymentMethod || 'cash', referenceNumber: referenceNumber || undefined,
      description: `Function revenue — ${func.name}${notes ? `: ${notes}` : ''}`,
      otherFeeAmount: Number(amount),
    });

    await prisma.functionActivity.create({
      data: { companyId, functionId, activityType: 'revenue_recorded', description: `Revenue recorded: ${Number(amount).toLocaleString()} via ${paymentMethod || 'cash'}${referenceNumber ? ` (ref ${referenceNumber})` : ''}` }
    });

    audit(req, 'FUNCTION_REVENUE', 'FunctionEvent', functionId, func.name,
      `Revenue recorded for "${func.name}": ${Number(amount).toLocaleString()} via ${paymentMethod || 'cash'} (posted to income ledger).`);
    res.status(201).json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── FUNCTION COMPLETION ──────────────────────────────────────────────────
app.post('/api/functions/:functionId/complete', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { completionNotes } = req.body;
  try {
    const func = await prisma.functionEvent.findFirst({ where: { id: functionId, companyId } });
    if (!func) return res.status(404).json({ error: 'Function not found.' });

    const updated = await prisma.functionEvent.update({
      where: { id: functionId },
      data: {
        status: 'Completed',
        completionNotes: completionNotes || null,
        completedAt: func.completedAt || new Date(),
      }
    });

    await prisma.functionActivity.create({
      data: { companyId, functionId, activityType: 'status_changed', description: `Function marked Completed.${completionNotes ? ` Notes: ${completionNotes}` : ''}` }
    });

    audit(req, 'FUNCTION_COMPLETED', 'FunctionEvent', functionId, updated.name, `Event "${updated.name}" marked Completed.`);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── FUNCTION SIGNATURES ──────────────────────────────────────────────────
app.get('/api/functions/:functionId/signatures', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  try {
    const list = await prisma.functionSignature.findMany({
      where: { companyId, functionId },
      orderBy: { id: 'desc' },
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/functions/:functionId/signatures', async (req, res) => {
  const companyId = getCompanyId(req);
  const functionId = parseInt(req.params.functionId);
  const { signatureType, signeeName, signeeContact, signatureData, confirmationNotes } = req.body;
  if (!signatureType || !signeeName || !signatureData) {
    return res.status(400).json({ error: 'signatureType, signeeName, and signatureData are required.' });
  }
  try {
    const sig = await prisma.functionSignature.create({
      data: { companyId, functionId, signatureType, signeeName, signeeContact: signeeContact || null, signatureData, confirmationNotes: confirmationNotes || null }
    });

    await prisma.functionActivity.create({
      data: { companyId, functionId, activityType: 'other', description: `Signature captured (${signatureType}) from ${signeeName}.` }
    });

    res.status(201).json(sig);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── FUNCTION TEMPLATES ───────────────────────────────────────────────────
app.get('/api/function-templates', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.functionTemplate.findMany({
      where: { companyId, isActive: true },
      include: { items: { include: { item: true, asset: true } } },
      orderBy: { name: 'asc' },
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/function-templates', async (req, res) => {
  const companyId = getCompanyId(req);
  const { name, description, defaultLocation, defaultTime, defaultNotes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required.' });
  try {
    const existing = await prisma.functionTemplate.findFirst({ where: { companyId, name } });
    if (existing) return res.status(409).json({ error: 'A template with that name already exists.' });

    const template = await prisma.functionTemplate.create({
      data: { companyId, name, description: description || null, defaultLocation: defaultLocation || null, defaultTime: defaultTime || null, defaultNotes: defaultNotes || null }
    });
    audit(req, 'CREATE', 'FunctionTemplate', template.id, template.name, `Event template created: ${template.name}.`);
    res.status(201).json(template);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/function-templates/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const templateId = parseInt(req.params.id);
  try {
    const tpl = await prisma.functionTemplate.findFirst({ where: { id: templateId, companyId } });
    await prisma.functionTemplate.deleteMany({ where: { id: templateId, companyId } });
    if (tpl) audit(req, 'DELETE', 'FunctionTemplate', tpl.id, tpl.name, `Event template deleted: ${tpl.name}.`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/function-templates/:id/items', async (req, res) => {
  const companyId = getCompanyId(req);
  const templateId = parseInt(req.params.id);
  const { itemType, itemId, assetId, quantity, notes } = req.body;
  if (!itemType || (itemType === 'item' && !itemId) || (itemType === 'asset' && !assetId)) {
    return res.status(400).json({ error: 'itemType and a matching itemId/assetId are required.' });
  }
  try {
    const template = await prisma.functionTemplate.findFirst({ where: { id: templateId, companyId } });
    if (!template) return res.status(404).json({ error: 'Template not found.' });

    const item = await prisma.functionTemplateItem.create({
      data: {
        templateId, itemType,
        itemId: itemType === 'item' ? parseInt(itemId) : null,
        assetId: itemType === 'asset' ? parseInt(assetId) : null,
        quantity: parseInt(quantity) || 1, notes: notes || null,
      }
    });
    res.status(201).json(item);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/function-template-items/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const item = await prisma.functionTemplateItem.findFirst({ where: { id }, include: { template: true } });
    if (!item || item.template.companyId !== companyId) return res.status(404).json({ error: 'Template item not found.' });
    await prisma.functionTemplateItem.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Create a new function from a template: copies name/location/time/notes defaults
// (overridable) and pre-books the template's items as FunctionItemAssignment rows.
app.post('/api/function-templates/:id/create-function', async (req, res) => {
  const companyId = getCompanyId(req);
  const templateId = parseInt(req.params.id);
  const { name, date, time, location, clientName, clientContact, notes } = req.body;
  if (!name || !date || !clientName) {
    return res.status(400).json({ error: 'name, date, and clientName are required.' });
  }
  try {
    const template = await prisma.functionTemplate.findFirst({ where: { id: templateId, companyId }, include: { items: true } });
    if (!template) return res.status(404).json({ error: 'Template not found.' });

    const func = await prisma.functionEvent.create({
      data: {
        companyId, name, date,
        time: time || template.defaultTime || '',
        location: location || template.defaultLocation || '',
        clientName, clientContact: clientContact || '',
        notes: notes || template.defaultNotes || null,
        templateName: template.name,
        functionItemAssignments: {
          create: template.items.map(ti => ({
            companyId,
            itemType: ti.itemType,
            itemId: ti.itemId,
            assetId: ti.assetId,
            quantity: ti.quantity,
            notes: ti.notes,
            status: 'booked',
          }))
        }
      },
      include: { functionItemAssignments: true }
    });

    await prisma.functionActivity.create({
      data: { companyId, functionId: func.id, activityType: 'other', description: `Function created from template "${template.name}" with ${template.items.length} pre-booked item(s).` }
    });

    res.status(201).json(func);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 2-Day Availability Checker Dashboard Alerts API
app.get('/api/dashboard/function-alerts', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const today = new Date();
    // Format date string as YYYY-MM-DD
    const targetDateObj = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);
    const targetDateStr = targetDateObj.toISOString().split('T')[0];

    const upcomingFunctions = await prisma.functionEvent.findMany({
      where: {
        companyId,
        status: { not: 'Cancelled' },
        date: targetDateStr
      },
      include: {
        functionItemAssignments: {
          where: { status: 'booked' },
          include: { item: true, asset: true }
        }
      }
    });

    const alerts = [];

    for (const func of upcomingFunctions) {
      for (const assign of func.functionItemAssignments) {
        if (assign.itemType === 'asset' && assign.asset) {
          // If asset is currently Rented or in Maintenance
          if (assign.asset.status !== 'Available') {
            alerts.push({
              id: assign.id,
              functionId: func.id,
              functionName: func.name,
              functionDate: func.date,
              type: 'asset',
              name: assign.asset.name,
              serialNumber: assign.asset.serialNumber,
              message: `Asset "${assign.asset.name}" (${assign.asset.serialNumber}) is reserved for "${func.name}" but its status is currently "${assign.asset.status}".`
            });
          }
        } else if (assign.itemType === 'item' && assign.item) {
          // If inventory stock is below the reserved quantity
          if (assign.item.currentStock < assign.quantity) {
            alerts.push({
              id: assign.id,
              functionId: func.id,
              functionName: func.name,
              functionDate: func.date,
              type: 'stock',
              name: assign.item.name,
              message: `Item "${assign.item.name}" has ${assign.item.currentStock} units in stock, but ${assign.quantity} units are reserved for "${func.name}".`
            });
          }
        }
      }
    }

    res.json(alerts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GLOBAL UNITS OF MEASURE ENDPOINTS ────────────────────────────────────────

app.get('/api/uoms', async (req, res) => {
  try {
    const list = await prisma.unitOfMeasure.findMany({
      where: { isActive: true },
      orderBy: [
        { category: 'asc' },
        { name: 'asc' }
      ]
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── CONSUMABLE STOCK ENDPOINTS ─────────────────────────────────────────────

app.get('/api/consumables', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.consumable.findMany({
      where: { companyId },
      include: {
        packageUnit: { select: { id: true, name: true, abbreviation: true, code: true } },
        pieceUnit: { select: { id: true, name: true, abbreviation: true, code: true } },
        unitOfMeasure: { select: { id: true, name: true, abbreviation: true, code: true } },
        taxRate: { select: { id: true, name: true, rate: true, taxCode: true } }
      },
      orderBy: { name: 'asc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/consumables', async (req, res) => {
  const companyId = getCompanyId(req);
  const { 
    name, 
    category, 
    stockQty, 
    restockLevel, 
    unitPrice, 
    costPrice, 
    sku,
    isMultiUnit,
    packageUnitId,
    pieceUnitId,
    unitRatio,
    packagePrice,
    unitOfMeasureId,
    taxRateId,
    commodityCode
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required.' });
  }

  try {
    const record = await prisma.consumable.create({
      data: {
        companyId,
        name,
        category: category || 'general',
        stockQty: stockQty !== undefined ? parseInt(stockQty) : 0,
        restockLevel: restockLevel !== undefined ? parseInt(restockLevel) : 0,
        unitPrice: unitPrice !== undefined ? Number(unitPrice) : 0,
        costPrice: costPrice !== undefined ? Number(costPrice) : 0,
        sku: sku || null,
        isMultiUnit: !!isMultiUnit,
        packageUnitId: packageUnitId ? parseInt(packageUnitId) : null,
        pieceUnitId: pieceUnitId ? parseInt(pieceUnitId) : null,
        unitRatio: unitRatio !== undefined ? parseInt(unitRatio) : 1,
        packagePrice: packagePrice !== undefined && packagePrice !== null ? Number(packagePrice) : null,
        unitOfMeasureId: unitOfMeasureId ? parseInt(unitOfMeasureId) : null,
        taxRateId: taxRateId ? parseInt(taxRateId) : null,
        commodityCode: commodityCode?.trim() || null,
      }
    });

    // Write initial log if stock is positive
    if (record.stockQty > 0) {
      await prisma.consumableLog.create({
        data: {
          consumableId: record.id,
          action: 'adjustment',
          quantity: record.stockQty,
          operator: 'system',
          notes: 'Initial stock register audit inflow.'
        }
      });
    }

    audit(req, 'CREATE', 'Consumable', record.id, record.name, `Consumable created: ${record.name} (stock ${record.stockQty}).`);
    res.status(201).json(record);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update a consumable, including its tax rate and URA registration details.
app.patch('/api/consumables/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { name, category, restockLevel, unitPrice, costPrice, isMultiUnit, packageUnitId, pieceUnitId, unitRatio, packagePrice } = req.body;
  try {
    const existing = await prisma.consumable.findFirst({ where: { id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Consumable not found.' });

    const data: any = { ...efrisCatalogFields(req.body) };
    if (name !== undefined) data.name = name;
    if (category !== undefined) data.category = category || 'general';
    if (restockLevel !== undefined) data.restockLevel = parseInt(restockLevel);
    if (unitPrice !== undefined) data.unitPrice = Number(unitPrice);
    if (costPrice !== undefined) data.costPrice = Number(costPrice);
    if (isMultiUnit !== undefined) data.isMultiUnit = !!isMultiUnit;
    if (packageUnitId !== undefined) data.packageUnitId = packageUnitId ? parseInt(packageUnitId) : null;
    if (pieceUnitId !== undefined) data.pieceUnitId = pieceUnitId ? parseInt(pieceUnitId) : null;
    if (unitRatio !== undefined) data.unitRatio = parseInt(unitRatio) || 1;
    if (packagePrice !== undefined) data.packagePrice = packagePrice === null || packagePrice === '' ? null : Number(packagePrice);

    const updated = await prisma.consumable.update({ where: { id }, data });
    audit(req, 'UPDATE', 'Consumable', id, updated.name, `Consumable updated: ${updated.name}.`);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/consumables/:id/use', async (req, res) => {
  const consumableId = parseInt(req.params.id);
  const { quantity, notes, operator } = req.body;

  if (quantity === undefined || parseInt(quantity) <= 0) {
    return res.status(400).json({ error: 'quantity must be positive.' });
  }

  try {
    const consumable = await prisma.consumable.findUnique({
      where: { id: consumableId }
    });

    if (!consumable) {
      return res.status(404).json({ error: 'Consumable not found.' });
    }

    const qty = parseInt(quantity);
    if (consumable.stockQty < qty) {
      return res.status(400).json({ error: `Insufficient stock in register. Current stock: ${consumable.stockQty}` });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updatedItem = await tx.consumable.update({
        where: { id: consumableId },
        data: { stockQty: { decrement: qty } }
      });

      await tx.consumableLog.create({
        data: {
          consumableId,
          action: 'use',
          quantity: qty,
          operator: operator || 'staff',
          notes: notes || 'Stock consumption.'
        }
      });

      return updatedItem;
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/consumables/:id/restock', async (req, res) => {
  const consumableId = parseInt(req.params.id);
  const { quantity, costPrice, notes, operator } = req.body;

  if (quantity === undefined || parseInt(quantity) <= 0) {
    return res.status(400).json({ error: 'quantity must be positive.' });
  }

  try {
    const consumable = await prisma.consumable.findUnique({
      where: { id: consumableId }
    });

    if (!consumable) {
      return res.status(404).json({ error: 'Consumable not found.' });
    }

    const qty = parseInt(quantity);

    const updated = await prisma.$transaction(async (tx) => {
      const dataUpdate: any = { stockQty: { increment: qty } };
      if (costPrice !== undefined) {
        dataUpdate.costPrice = Number(costPrice);
      }

      const updatedItem = await tx.consumable.update({
        where: { id: consumableId },
        data: dataUpdate
      });

      await tx.consumableLog.create({
        data: {
          consumableId,
          action: 'restock',
          quantity: qty,
          operator: operator || 'staff',
          notes: notes || 'Restock replenishment.'
        }
      });

      return updatedItem;
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/consumables/:id/logs', async (req, res) => {
  const consumableId = parseInt(req.params.id);
  try {
    const list = await prisma.consumableLog.findMany({
      where: { consumableId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── CONSOLIDATED REVENUE LEDGER ENDPOINTS ──────────────────────────────────

// Fetch all income records with filters and search
// Helper to build dynamic query filters for consolidated revenue ledger
async function buildIncomeWhereClause(companyId: number, query: any) {
  const { incomeSource, paymentMethod, startDate, endDate, search, category, customerName } = query;
  const whereClause: any = { companyId };

  if (incomeSource) {
    whereClause.incomeSource = String(incomeSource);
  }
  if (paymentMethod) {
    whereClause.paymentMethod = String(paymentMethod);
  }

  if (startDate || endDate) {
    whereClause.paymentDate = {};
    if (startDate) {
      whereClause.paymentDate.gte = new Date(String(startDate));
    }
    if (endDate) {
      const end = new Date(String(endDate));
      end.setHours(23, 59, 59, 999);
      whereClause.paymentDate.lte = end;
    }
  }

  if (search) {
    whereClause.OR = [
      { description: { contains: String(search) } },
      { referenceNumber: { contains: String(search) } }
    ];
  }

  if (customerName) {
    const cust = String(customerName);
    whereClause.description = { contains: cust };
  }

  if (category) {
    const cat = String(category);
    
    // Find matching bookings
    const matchingBookings = await prisma.booking.findMany({
      where: {
        companyId,
        lineItems: {
          some: {
            OR: [
              { item: { category: { equals: cat } } },
              { asset: { assetType: { equals: cat } } },
              { consumable: { category: { equals: cat } } }
            ]
          }
        }
      },
      select: { bookingNumber: true }
    });
    const bookingNums = matchingBookings.map(b => b.bookingNumber);

    // Find matching rental orders
    const matchingOrders = await prisma.rentalOrder.findMany({
      where: {
        companyId,
        lineItems: {
          some: {
            OR: [
              { item: { category: { equals: cat } } },
              { asset: { assetType: { equals: cat } } },
              { consumable: { category: { equals: cat } } }
            ]
          }
        }
      },
      select: { companyOrderNumber: true }
    });
    const orderNums = matchingOrders.map(o => o.companyOrderNumber);

    const refCodes = [...bookingNums, ...orderNums];
    
    if (whereClause.OR) {
      whereClause.AND = [
        { OR: whereClause.OR },
        {
          OR: [
            { referenceNumber: { in: refCodes } },
            { description: { contains: cat } }
          ]
        }
      ];
      delete whereClause.OR;
    } else {
      whereClause.OR = [
        { referenceNumber: { in: refCodes } },
        { description: { contains: cat } }
      ];
    }
  }

  return whereClause;
}

app.get('/api/income', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const whereClause = await buildIncomeWhereClause(companyId, req.query);
    const list = await prisma.income.findMany({
      where: whereClause,
      orderBy: { paymentDate: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Export the filtered revenue ledger to CSV (honours the same query filters as /api/income)
app.get('/api/export/income', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const whereClause = await buildIncomeWhereClause(companyId, req.query);
    const list = await prisma.income.findMany({ where: whereClause, orderBy: { paymentDate: 'desc' } });
    let csv = 'paymentDate,incomeSource,amount,paymentMethod,referenceNumber,description,baseRentalAmount,lateFeeAmount,damageFeeAmount,depositAmount\n';
    list.forEach(r => {
      const date = new Date(r.paymentDate).toISOString().split('T')[0];
      csv += `${date},${csvCell(r.incomeSource)},${r.amount},${csvCell(r.paymentMethod)},${csvCell(r.referenceNumber)},${csvCell(r.description)},${r.baseRentalAmount},${r.lateFeeAmount},${r.damageFeeAmount},${r.depositAmount}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=revenue-report.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Record manual miscellaneous income
app.post('/api/income', async (req, res) => {
  const companyId = getCompanyId(req);
  const { amount, paymentMethod, paymentDate, referenceNumber, description, baseRentalAmount, lateFeeAmount, damageFeeAmount, depositAmount, otherFeeAmount } = req.body;

  if (amount === undefined || !paymentMethod || !description) {
    return res.status(400).json({ error: 'amount, paymentMethod, and description are required.' });
  }

  try {
    const record = await recordIncome({
      companyId,
      incomeSource: 'manual',
      amount: Number(amount),
      paymentMethod,
      referenceNumber: referenceNumber || undefined,
      description,
      baseRentalAmount: baseRentalAmount ? Number(baseRentalAmount) : 0,
      lateFeeAmount: lateFeeAmount ? Number(lateFeeAmount) : 0,
      damageFeeAmount: damageFeeAmount ? Number(damageFeeAmount) : 0,
      depositAmount: depositAmount ? Number(depositAmount) : 0,
      otherFeeAmount: otherFeeAmount ? Number(otherFeeAmount) : Number(amount) // default other fee to amount for manual entries
    });

    audit(req, 'CREATE', 'Income', (record as any)?.id ?? null, referenceNumber || description,
      `Manual income recorded: ${Number(amount).toLocaleString()} via ${paymentMethod} — ${description}.`);
    res.status(201).json(record);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch income analytical metrics and summaries
app.get('/api/income/analytics', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const whereClause = await buildIncomeWhereClause(companyId, req.query);
    const allRecords = await prisma.income.findMany({
      where: whereClause
    });

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    let todayTotal = 0;
    let monthTotal = 0;
    let yearTotal = 0;
    let allTimeTotal = 0;

    const sourceTotals: Record<string, number> = {
      rental_order: 0,
      booking_deposit: 0,
      late_fee: 0,
      damage_fee: 0,
      invoice_payment: 0,
      manual: 0
    };

    const methodTotals: Record<string, number> = {
      cash: 0,
      check: 0,
      credit_card: 0,
      bank_transfer: 0,
      stripe: 0,
      mobile_money: 0,
      other: 0
    };

    for (const rec of allRecords) {
      const amt = Number(rec.amount);
      const pDate = new Date(rec.paymentDate);
      const pDateStr = pDate.toISOString().split('T')[0];

      allTimeTotal += amt;

      // Group totals
      if (pDateStr === todayStr) {
        todayTotal += amt;
      }
      if (pDate.getMonth() === currentMonth && pDate.getFullYear() === currentYear) {
        monthTotal += amt;
      }
      if (pDate.getFullYear() === currentYear) {
        yearTotal += amt;
      }

      // Source breakdown
      const src = rec.incomeSource;
      if (sourceTotals[src] !== undefined) {
        sourceTotals[src] += amt;
      } else {
        sourceTotals[src] = amt;
      }

      // Method breakdown
      const method = rec.paymentMethod;
      if (methodTotals[method] !== undefined) {
        methodTotals[method] += amt;
      } else {
        methodTotals[method] = amt;
      }
    }

    res.json({
      todayTotal,
      monthTotal,
      yearTotal,
      allTimeTotal,
      bySource: sourceTotals,
      byMethod: methodTotals
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── HELP & SUPPORT KNOWLEDGE DATABASE ENDPOINTS ────────────────────────────

// Fetch categories with article counts
app.get('/api/help/categories', async (req, res) => {
  try {
    const categories = await prisma.helpCategory.findMany({
      include: {
        _count: {
          select: { articles: true }
        }
      },
      orderBy: { name: 'asc' }
    });
    res.json(categories);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch articles with filters
app.get('/api/help/articles', async (req, res) => {
  const { categoryId, search } = req.query;
  try {
    const where: any = {};
    if (categoryId) {
      where.categoryId = parseInt(String(categoryId));
    }
    if (search) {
      where.OR = [
        { title: { contains: String(search) } },
        { content: { contains: String(search) } }
      ];
    }
    const articles = await prisma.helpArticle.findMany({
      where,
      select: {
        id: true,
        categoryId: true,
        title: true,
        slug: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: { title: 'asc' }
    });
    res.json(articles);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch detailed guide content
app.get('/api/help/articles/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const article = await prisma.helpArticle.findUnique({
      where: { id }
    });
    if (!article) return res.status(404).json({ error: 'Guide article not found.' });
    res.json(article);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch FAQs list
app.get('/api/help/faqs', async (req, res) => {
  try {
    const list = await prisma.fAQ.findMany({
      orderBy: { displayOrder: 'asc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── SYSTEM HEALTH / INCIDENTS BOARD ENDPOINTS ──────────────────────────────

// List all system components with incident counts
app.get('/api/system/components', async (req, res) => {
  try {
    const components = await prisma.systemComponent.findMany({
      include: {
        _count: { select: { incidents: true } },
        incidents: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: { name: 'asc' }
    });
    res.json(components);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update a component's status
app.patch('/api/system/components/:id/status', async (req, res) => {
  const id = parseInt(req.params.id);
  const { status } = req.body;
  const validStatuses = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }
  try {
    const updated = await prisma.systemComponent.update({
      where: { id },
      data: { status }
    });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// List incidents for a component (or all)
app.get('/api/system/incidents', async (req, res) => {
  const { componentId } = req.query;
  try {
    const where: any = {};
    if (componentId) where.componentId = parseInt(String(componentId));
    const incidents = await prisma.systemIncident.findMany({
      where,
      include: { component: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json(incidents);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Log a new incident
app.post('/api/system/incidents', async (req, res) => {
  const { componentId, title, severity, message, reporter } = req.body;
  if (!componentId || !title || !message) {
    return res.status(400).json({ error: 'componentId, title, and message are required.' });
  }
  try {
    const incident = await prisma.systemIncident.create({
      data: {
        componentId: parseInt(componentId),
        title,
        severity: severity || 'info',
        message,
        reporter: reporter || 'system'
      }
    });
    res.status(201).json(incident);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Resolve an incident
app.patch('/api/system/incidents/:id/resolve', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const updated = await prisma.systemIncident.update({
      where: { id },
      data: { severity: 'resolved', resolvedAt: new Date() }
    });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── EMPLOYEES ──────────────────────────────────────────────────────────

app.get('/api/employees', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.employee.findMany({
      where: { companyId },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/employees', async (req, res) => {
  const { companyId, name, role, billingRateToClient, payStructure, payRate } = req.body;
  if (!companyId || !name) {
    return res.status(400).json({ error: 'companyId and name are required.' });
  }
  try {
    const employee = await prisma.employee.create({
      data: {
        companyId: parseInt(companyId),
        name,
        role: role || '',
        billingRateToClient: Number(billingRateToClient || 0),
        payStructure: payStructure || 'Per Function',
        payRate: Number(payRate || 0)
      }
    });
    audit(req, 'CREATE', 'Employee', employee.id, employee.name, `Staff member added: ${employee.name}${employee.role ? ` (${employee.role})` : ''}.`);
    res.status(201).json(employee);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── SITES ──────────────────────────────────────────────────────────────

app.get('/api/sites', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.site.findMany({
      where: { companyId },
      include: {
        siteAssignments: {
          include: {
            employee: true
          }
        }
      },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sites', async (req, res) => {
  const { companyId, name, location, contactPerson, contactInfo, notes } = req.body;
  if (!companyId || !name) {
    return res.status(400).json({ error: 'companyId and name are required.' });
  }
  try {
    const site = await prisma.site.create({
      data: {
        companyId: parseInt(companyId),
        name,
        location: location || '',
        contactPerson: contactPerson || '',
        contactInfo: contactInfo || '',
        notes: notes || ''
      }
    });
    audit(req, 'CREATE', 'Site', site.id, site.name, `Client site created: ${site.name}${site.location ? ` — ${site.location}` : ''}.`);
    res.status(201).json(site);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sites/:id/assign', async (req, res) => {
  const siteId = parseInt(req.params.id);
  const { companyId, employeeId, isPrimary, notes } = req.body;
  if (!companyId || !employeeId) {
    return res.status(400).json({ error: 'companyId and employeeId are required.' });
  }
  try {
    const assignment = await prisma.siteAssignment.upsert({
      where: {
        siteId_employeeId: {
          siteId,
          employeeId: parseInt(employeeId)
        }
      },
      update: {
        isPrimary: !!isPrimary,
        notes: notes || ''
      },
      create: {
        companyId: parseInt(companyId),
        siteId,
        employeeId: parseInt(employeeId),
        isPrimary: !!isPrimary,
        notes: notes || ''
      }
    });
    audit(req, 'SITE_ASSIGN', 'Site', siteId, String(siteId), `Staff #${employeeId} assigned to site #${siteId}${isPrimary ? ' (primary)' : ''}.`);
    res.status(201).json(assignment);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── EVENTS / FUNCTIONS ──────────────────────────────────────────────────

app.get('/api/functions', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.functionEvent.findMany({
      where: { companyId },
      include: {
        functionAssignments: {
          include: {
            employee: true,
            role: true
          }
        }
      },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/functions', async (req, res) => {
  const { companyId, name, date, time, location, clientName, clientContact, notes } = req.body;
  if (!companyId || !name || !date || !location) {
    return res.status(400).json({ error: 'companyId, name, date, and location are required.' });
  }
  try {
    const fn = await prisma.functionEvent.create({
      data: {
        companyId: parseInt(companyId),
        name,
        date,
        time: time || '',
        location,
        clientName: clientName || '',
        clientContact: clientContact || '',
        notes: notes || '',
        status: 'Scheduled'
      }
    });
    audit(req, 'CREATE', 'FunctionEvent', fn.id, fn.name, `Event created: ${fn.name} on ${fn.date}${fn.location ? ` at ${fn.location}` : ''}.`);
    res.status(201).json(fn);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/functions/:id/assign', async (req, res) => {
  const functionId = parseInt(req.params.id);
  const { companyId, employeeId, roleId, startTime, endTime, notes } = req.body;
  if (!companyId || !employeeId || !roleId) {
    return res.status(400).json({ error: 'companyId, employeeId, and roleId are required.' });
  }
  try {
    const assignment = await prisma.functionAssignment.upsert({
      where: {
        functionId_employeeId_roleId: {
          functionId,
          employeeId: parseInt(employeeId),
          roleId: parseInt(roleId)
        }
      },
      update: {
        startTime: startTime || '',
        endTime: endTime || '',
        notes: notes || ''
      },
      create: {
        companyId: parseInt(companyId),
        functionId,
        employeeId: parseInt(employeeId),
        roleId: parseInt(roleId),
        startTime: startTime || '',
        endTime: endTime || '',
        notes: notes || '',
        status: 'Assigned'
      }
    });
    res.status(201).json(assignment);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/function-roles', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.functionRole.findMany({
      where: { companyId }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// ── SUPPLIERS ──────────────────────────────────────────────────────────

app.get('/api/suppliers', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.supplier.findMany({
      where: { companyId },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/suppliers', async (req, res) => {
  const { companyId, name, contactPerson, phone, email, address, notes } = req.body;
  if (!companyId || !name) {
    return res.status(400).json({ error: 'companyId and name are required.' });
  }
  try {
    const supplier = await prisma.supplier.create({
      data: {
        companyId: parseInt(companyId),
        name,
        contactPerson: contactPerson || '',
        phone: phone || '',
        email: email || '',
        address: address || '',
        notes: notes || ''
      }
    });
    audit(req, 'CREATE', 'Supplier', supplier.id, supplier.name, `Supplier created: ${supplier.name}.`);
    res.status(201).json(supplier);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── PURCHASE ORDERS ────────────────────────────────────────────────────

app.get('/api/purchase-orders', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.purchaseOrder.findMany({
      where: { companyId },
      include: {
        supplier: true,
        lineItems: {
          include: {
            item: true
          }
        }
      },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/purchase-orders', async (req, res) => {
  const { companyId, supplierId, poNumber, orderDate, deliveryDate, notes, lineItems } = req.body;
  if (!companyId || !supplierId || !poNumber || !orderDate || !lineItems || !Array.isArray(lineItems)) {
    return res.status(400).json({ error: 'companyId, supplierId, poNumber, orderDate, and lineItems array are required.' });
  }
  try {
    let total = 0;
    const itemsData = lineItems.map((li: any) => {
      const qty = parseInt(li.quantity || 1);
      const unit = Number(li.unitCost || 0);
      const lineCost = qty * unit;
      total += lineCost;
      return {
        companyId: parseInt(companyId),
        itemId: li.itemId ? parseInt(li.itemId) : null,
        description: li.description || '',
        quantity: qty,
        unitCost: unit,
        totalCost: lineCost
      };
    });

    const po = await prisma.purchaseOrder.create({
      data: {
        companyId: parseInt(companyId),
        supplierId: parseInt(supplierId),
        poNumber,
        orderDate,
        deliveryDate: deliveryDate || '',
        totalAmount: total,
        status: 'Draft',
        notes: notes || '',
        lineItems: {
          create: itemsData
        }
      },
      include: {
        lineItems: true
      }
    });
    audit(req, 'CREATE', 'PurchaseOrder', po.id, po.poNumber, `Purchase order ${po.poNumber} created — total ${total.toLocaleString()}.`);
    res.status(201).json(po);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

const PO_TRANSITIONS: Record<string, string[]> = {
  Draft: ['Ordered', 'Received', 'Cancelled'],
  Ordered: ['Received', 'Cancelled'],
  Received: [],   // terminal: stock has been taken in (correct with a reversal)
  Cancelled: [],
};
app.patch('/api/purchase-orders/:id/status', async (req, res) => {
  const companyId = getCompanyId(req);
  const poId = parseInt(req.params.id);
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required.' });
  if (!(status in PO_TRANSITIONS)) return res.status(400).json({ error: `Unknown status "${status}".` });

  try {
    const existingPo = await prisma.purchaseOrder.findFirst({ where: { id: poId, companyId }, include: { lineItems: true } });
    if (!existingPo) return res.status(404).json({ error: 'Purchase Order not found.' });
    const oldStatus = existingPo.status;
    const newStatus = status;
    if (oldStatus === newStatus) return res.json({ success: true, newStatus });
    if (!(PO_TRANSITIONS[oldStatus] || []).includes(newStatus)) {
      return res.status(400).json({ error: `A purchase order cannot move from ${oldStatus} to ${newStatus}.` });
    }

    await prisma.$transaction(async (tx) => {
      // Conditional on the status we validated: a concurrent receipt can't also
      // pass, so stock is received exactly once.
      const moved = await tx.purchaseOrder.updateMany({ where: { id: poId, companyId, status: oldStatus }, data: { status: newStatus } });
      if (moved.count !== 1) throw new WorkflowError('This purchase order was updated by someone else. Refresh and try again.', 409);
      if (newStatus === 'Received') {
        for (const itemLine of existingPo.lineItems) {
          if (itemLine.itemId) {
            await tx.item.updateMany({ where: { id: itemLine.itemId, companyId }, data: { currentStock: { increment: itemLine.quantity } } });
          }
        }
      }
    });

    audit(req, 'PO_STATUS', 'PurchaseOrder', poId, existingPo.poNumber,
      `Purchase order ${existingPo.poNumber} status: ${oldStatus} → ${newStatus}${newStatus === 'Received' && oldStatus !== 'Received' ? ' (stock received into inventory)' : ''}.`);
    res.json({ success: true, newStatus });
  } catch (err: any) {
    if (err instanceof WorkflowError) return res.status(err.status).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

// ── EXPENSES ───────────────────────────────────────────────────────────

app.get('/api/expenses', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.expense.findMany({
      where: { companyId },
      include: {
        supplier: true
      },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/expenses', async (req, res) => {
  const { companyId, supplierId, amount, expenseCategory, expenseDate, paymentMethod, notes } = req.body;
  if (!companyId || !amount || !expenseCategory || !expenseDate || !paymentMethod) {
    return res.status(400).json({ error: 'companyId, amount, expenseCategory, expenseDate, and paymentMethod are required.' });
  }
  try {
    const exp = await prisma.expense.create({
      data: {
        companyId: parseInt(companyId),
        supplierId: supplierId ? parseInt(supplierId) : null,
        amount: Number(amount),
        expenseCategory,
        expenseDate,
        paymentMethod,
        notes: notes || ''
      }
    });
    audit(req, 'CREATE', 'Expense', exp.id, expenseCategory, `Expense recorded: ${Number(amount).toLocaleString()} — ${expenseCategory} via ${paymentMethod}.`);
    res.status(201).json(exp);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── PAYROLL ────────────────────────────────────────────────────────────

app.get('/api/payroll-periods', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.payrollPeriod.findMany({
      where: { companyId },
      include: {
        payments: {
          include: {
            employee: true
          }
        }
      },
      orderBy: { id: 'desc' }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payroll-periods', async (req, res) => {
  const { companyId, startDate, endDate } = req.body;
  if (!companyId || !startDate || !endDate) {
    return res.status(400).json({ error: 'companyId, startDate, and endDate are required.' });
  }
  try {
    const events = await prisma.functionEvent.findMany({
      where: {
        companyId: parseInt(companyId),
        date: {
          gte: startDate,
          lte: endDate
        }
      },
      include: {
        functionAssignments: {
          include: {
            employee: true
          }
        }
      }
    });

    const employeeEarnings: Record<number, { amount: number, employeeId: number, notes: string }> = {};

    for (const ev of events) {
      for (const asn of ev.functionAssignments) {
        if (!asn.employee || !asn.employee.isActive) continue;

        const emp = asn.employee;
        const rate = Number(emp.payRate);

        if (!employeeEarnings[emp.id]) {
          employeeEarnings[emp.id] = {
            employeeId: emp.id,
            amount: 0,
            notes: ''
          };
        }

        if (emp.payStructure === 'Per Function') {
          employeeEarnings[emp.id].amount += rate;
          employeeEarnings[emp.id].notes += `Event: "${ev.name}" (Per Function @ UGX ${rate.toLocaleString()}); `;
        } else if (emp.payStructure === 'Daily') {
          employeeEarnings[emp.id].amount += rate;
          employeeEarnings[emp.id].notes += `Date: ${ev.date} (Daily Pay @ UGX ${rate.toLocaleString()}); `;
        } else {
          employeeEarnings[emp.id].amount += rate;
          employeeEarnings[emp.id].notes += `Allocation: ${ev.date} (@ UGX ${rate.toLocaleString()}); `;
        }
      }
    }

    const earningsArray = Object.values(employeeEarnings);
    const totalSpent = earningsArray.reduce((acc, curr) => acc + curr.amount, 0);

    const period = await prisma.$transaction(async (tx) => {
      const newPeriod = await tx.payrollPeriod.create({
        data: {
          companyId: parseInt(companyId),
          startDate,
          endDate,
          status: 'Open',
          totalSpent: totalSpent
        }
      });

      for (const earn of earningsArray) {
        await tx.payrollPayment.create({
          data: {
            companyId: parseInt(companyId),
            payrollPeriodId: newPeriod.id,
            employeeId: earn.employeeId,
            amount: earn.amount,
            status: 'Unpaid',
            notes: earn.notes
          }
        });
      }

      return newPeriod;
    });

    audit(req, 'CREATE', 'PayrollPeriod', period.id, `${startDate} → ${endDate}`,
      `Payroll period generated (${startDate} → ${endDate}): ${earningsArray.length} payment(s), total ${totalSpent.toLocaleString()}.`);
    res.status(201).json(period);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/payroll-payments/:id/pay', async (req, res) => {
  const payId = parseInt(req.params.id);
  const { paymentMethod, paymentDate, notes } = req.body;
  if (!paymentMethod || !paymentDate) {
    return res.status(400).json({ error: 'paymentMethod and paymentDate are required.' });
  }
  try {
    const updated = await prisma.payrollPayment.update({
      where: { id: payId },
      data: {
        status: 'Paid',
        paymentMethod,
        paymentDate,
        notes: notes || undefined
      }
    });
    audit(req, 'PAYROLL_PAID', 'PayrollPayment', updated.id, String(updated.id),
      `Payroll payment #${updated.id} marked Paid (${Number(updated.amount).toLocaleString()}) via ${paymentMethod}.`);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/payroll-periods/:id/status', async (req, res) => {
  const periodId = parseInt(req.params.id);
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required.' });
  try {
    const updated = await prisma.payrollPeriod.update({
      where: { id: periodId },
      data: { status }
    });
    audit(req, 'PAYROLL_STATUS', 'PayrollPeriod', updated.id, String(updated.id), `Payroll period #${updated.id} status → ${status}.`);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});


app.get('/api/items', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.item.findMany({
      where: { companyId },
      include: {
        taxRate: { select: { id: true, name: true, rate: true, taxCode: true } },
        unitOfMeasureRef: { select: { id: true, code: true, name: true, abbreviation: true } },
      }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create new Item
app.post('/api/items', async (req, res) => {
  const {
    companyId, name, category, unitOfMeasure, unitCost, unitReplacementCost, dailyRentalRate,
    currentStock, lowStockThreshold, sku, unitOfMeasureId, taxRateId, commodityCode,
  } = req.body;
  try {
    const newItem = await prisma.item.create({
      data: {
        companyId: parseInt(companyId),
        name,
        category,
        unitOfMeasure: unitOfMeasure || "piece",
        unitCost: Number(unitCost || 0),
        unitReplacementCost: Number(unitReplacementCost || 0),
        dailyRentalRate: Number(dailyRentalRate || 0),
        currentStock: parseInt(currentStock || 0),
        lowStockThreshold: parseInt(lowStockThreshold || 5),
        sku: sku?.trim() || null,
        unitOfMeasureId: unitOfMeasureId ? parseInt(unitOfMeasureId) : null,
        taxRateId: taxRateId ? parseInt(taxRateId) : null,
        commodityCode: commodityCode?.trim() || null,
      }
    });
    audit(req, 'CREATE', 'Item', newItem.id, newItem.name, `Bulk item created: ${newItem.name} (stock ${newItem.currentStock}).`);
    res.status(201).json(newItem);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update a bulk hire item. Also the only way to set its SKU, unit, tax rate and
// URA commodity / excise details, which EFRIS registration depends on.
app.patch('/api/items/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { name, category, unitOfMeasure, unitCost, unitReplacementCost, dailyRentalRate, currentStock, lowStockThreshold } = req.body;
  try {
    const existing = await prisma.item.findFirst({ where: { id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Item not found.' });

    const data: any = { ...efrisCatalogFields(req.body) };
    if (name !== undefined) data.name = name;
    if (category !== undefined) data.category = category;
    if (unitOfMeasure !== undefined) data.unitOfMeasure = unitOfMeasure || 'piece';
    if (unitCost !== undefined) data.unitCost = Number(unitCost);
    if (unitReplacementCost !== undefined) data.unitReplacementCost = Number(unitReplacementCost);
    if (dailyRentalRate !== undefined) data.dailyRentalRate = Number(dailyRentalRate);
    if (currentStock !== undefined) data.currentStock = parseInt(currentStock);
    if (lowStockThreshold !== undefined) data.lowStockThreshold = parseInt(lowStockThreshold);

    const updated = await prisma.item.update({ where: { id }, data });
    audit(req, 'UPDATE', 'Item', id, updated.name, `Item updated: ${updated.name}.`);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Fetch all serialized assets
app.get('/api/serialized-assets', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.serializedAsset.findMany({
      where: { companyId },
      include: {
        taxRate: { select: { id: true, name: true, rate: true, taxCode: true } },
        unitOfMeasureRef: { select: { id: true, code: true, name: true, abbreviation: true } },
      }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create new Serialized Asset
app.post('/api/serialized-assets', async (req, res) => {
  const {
    companyId, name, assetType, serialNumber, costPrice, dailyRentalRate, replacementCost, status,
    sku, unitOfMeasureId, taxRateId, commodityCode,
  } = req.body;
  try {
    const newAsset = await prisma.serializedAsset.create({
      data: {
        companyId: parseInt(companyId),
        name,
        assetType,
        serialNumber,
        costPrice: Number(costPrice || 0),
        dailyRentalRate: Number(dailyRentalRate || 0),
        replacementCost: Number(replacementCost || 0),
        status: status || "Available",
        sku: sku?.trim() || null,
        unitOfMeasureId: unitOfMeasureId ? parseInt(unitOfMeasureId) : null,
        taxRateId: taxRateId ? parseInt(taxRateId) : null,
        commodityCode: commodityCode?.trim() || null,
      }
    });
    audit(req, 'CREATE', 'SerializedAsset', newAsset.id, newAsset.serialNumber || newAsset.name, `Serialized asset created: ${newAsset.name} (S/N ${newAsset.serialNumber}).`);
    res.status(201).json(newAsset);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update Serialized Asset details/status
app.patch('/api/serialized-assets/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const {
    name, assetType, serialNumber, costPrice, dailyRentalRate, replacementCost, status,
    sku, unitOfMeasureId, taxRateId, commodityCode, haveExciseTax, exciseDutyCode,
  } = req.body;
  try {
    const updatedAsset = await prisma.serializedAsset.update({
      where: { id },
      data: {
        name,
        assetType,
        serialNumber,
        costPrice: costPrice !== undefined ? Number(costPrice) : undefined,
        dailyRentalRate: dailyRentalRate !== undefined ? Number(dailyRentalRate) : undefined,
        replacementCost: replacementCost !== undefined ? Number(replacementCost) : undefined,
        status,
        ...efrisCatalogFields({ sku, unitOfMeasureId, taxRateId, commodityCode, haveExciseTax, exciseDutyCode }),
      }
    });
    audit(req, 'UPDATE', 'SerializedAsset', updatedAsset.id, updatedAsset.serialNumber || updatedAsset.name, `Asset updated${status ? ` — status: ${status}` : ''}.`);
    res.json(updatedAsset);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 4. Fetch Bookings list
app.get('/api/bookings', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.booking.findMany({
      where: { companyId },
      include: {
        lineItems: {
          include: {
            item: true,
            asset: true,
            consumable: {
              include: {
                packageUnit: true,
                pieceUnit: true,
                unitOfMeasure: true
              }
            },
            unitOfMeasure: true
          }
        }
      }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Create Booking (With Line Items)
class WorkflowError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// 5. Create Booking (With Line Items)
// Booking states: pending (no deposit yet) → confirmed (deposit collected, or
// none required) → converted (dispatched to a rental order) | cancelled.
app.post('/api/bookings', async (req, res) => {
  const companyId = getCompanyId(req);
  const { customerName, contactInfo, bookingType, scheduledPickupDate, scheduledReturnDate, depositAmount, lineItems } = req.body;
  try {
    if (!customerName || !String(customerName).trim()) throw new WorkflowError('Customer name is required.');
    if (!Array.isArray(lineItems) || lineItems.length === 0) throw new WorkflowError('At least one line item is required.');
    if (lineItems.length > 500) throw new WorkflowError('Too many line items.');
    const pickup = new Date(scheduledPickupDate);
    const returnD = new Date(scheduledReturnDate);
    if (isNaN(pickup.getTime()) || isNaN(returnD.getTime())) throw new WorkflowError('Valid pickup and return dates are required.');
    const rentalDays = getDaysBetween(pickup, returnD);

    const qtyOf = (li: any) => {
      const q = parseInt(li.quantity);
      if (!Number.isInteger(q) || q < 1) throw new WorkflowError('Each line needs a whole quantity of at least 1.');
      return q;
    };
    const itemLines = lineItems.filter((li: any) => li.itemType === 'item' || !li.itemType);
    const assetLines = lineItems.filter((li: any) => li.itemType === 'asset');
    const consumableLines = lineItems.filter((li: any) => li.itemType === 'consumable');
    if (itemLines.length + assetLines.length + consumableLines.length !== lineItems.length) {
      throw new WorkflowError('Unknown line item type.');
    }

    // Catalog lookups are scoped to this company.
    const [itemsDb, assetsDb, consumablesDb] = await Promise.all([
      itemLines.length ? prisma.item.findMany({ where: { companyId, id: { in: itemLines.map((li: any) => parseInt(li.itemId)) } } }) : [],
      assetLines.length ? prisma.serializedAsset.findMany({ where: { companyId, id: { in: assetLines.map((li: any) => parseInt(li.assetId)) } } }) : [],
      consumableLines.length ? prisma.consumable.findMany({ where: { companyId, id: { in: consumableLines.map((li: any) => parseInt(li.consumableId)) } } }) : [],
    ]);

    let estimatedTotal = 0;
    const parsedLines: any[] = [];

    for (const li of itemLines) {
      const dbItem = itemsDb.find(item => item.id === parseInt(li.itemId));
      if (!dbItem) throw new WorkflowError(`Hire item ${li.itemId} not found in catalog.`);
      const quantity = qtyOf(li);
      const rate = Number(dbItem.dailyRentalRate);
      const lineTotal = rate * quantity * rentalDays;
      estimatedTotal += lineTotal;
      parsedLines.push({ itemType: 'item', itemId: dbItem.id, quantity, dailyRateAtBooking: rate, estimatedRentalDays: rentalDays, estimatedLineTotal: lineTotal });
    }

    // Serialized assets are booked by their own ID, one unit each, so the same
    // serial number is carried through booking, order, invoice and return.
    const seenAssets = new Set<number>();
    for (const li of assetLines) {
      const asset = assetsDb.find(a => a.id === parseInt(li.assetId));
      if (!asset) throw new WorkflowError(`Asset ${li.assetId} not found in catalog.`);
      if (seenAssets.has(asset.id)) throw new WorkflowError(`Asset "${asset.name}" (${asset.serialNumber}) is listed twice.`);
      seenAssets.add(asset.id);
      if (li.quantity !== undefined && parseInt(li.quantity) !== 1) throw new WorkflowError(`A serialized asset is booked one unit at a time ("${asset.name}").`);
      const rate = Number(asset.dailyRentalRate);
      const lineTotal = rate * rentalDays;
      estimatedTotal += lineTotal;
      parsedLines.push({ itemType: 'asset', assetId: asset.id, quantity: 1, dailyRateAtBooking: rate, estimatedRentalDays: rentalDays, estimatedLineTotal: lineTotal });
    }

    for (const li of consumableLines) {
      const dbConsumable = consumablesDb.find(c => c.id === parseInt(li.consumableId));
      if (!dbConsumable) throw new WorkflowError(`Consumable item ${li.consumableId} not found in catalog.`);
      const quantity = qtyOf(li);
      let rate = Number(dbConsumable.unitPrice);
      if (dbConsumable.isMultiUnit && li.unitOfMeasureId && Number(li.unitOfMeasureId) === dbConsumable.packageUnitId) {
        rate = dbConsumable.packagePrice ? Number(dbConsumable.packagePrice) : Number(dbConsumable.unitPrice);
      }
      const lineTotal = rate * quantity;
      estimatedTotal += lineTotal;
      parsedLines.push({
        itemType: 'consumable', consumableId: dbConsumable.id,
        unitOfMeasureId: li.unitOfMeasureId ? parseInt(li.unitOfMeasureId) : null,
        quantity, dailyRateAtBooking: rate, estimatedRentalDays: 1, estimatedLineTotal: lineTotal
      });
    }

    const deposit = round2(Number(depositAmount) || 0);
    if (deposit < 0) throw new WorkflowError('Deposit cannot be negative.');
    if (deposit > round2(estimatedTotal) + 0.005) throw new WorkflowError('Deposit cannot exceed the booking total.');
    const depositPaid = deposit > 0;
    const bookingNum = makeReference('B');

    // Booking, deposit ledger credit and income commit together. A deposit taken
    // at creation means the booking is confirmed — it must not sit in 'pending'
    // where it can neither be collected again nor dispatched.
    const { newBooking, customerId } = await prisma.$transaction(async (tx) => {
      const customer = (await tx.customer.findFirst({ where: { companyId, name: String(customerName).trim() } }))
        ?? await tx.customer.create({ data: { companyId, name: String(customerName).trim(), contactInfo: contactInfo || '', isOnWatchList: false } });
      const newBooking = await tx.booking.create({
        data: {
          companyId,
          customerId: customer.id,
          customerName,
          contactInfo,
          bookingType,
          scheduledPickupDate: pickup,
          scheduledReturnDate: returnD,
          estimatedTotalCost: estimatedTotal,
          depositAmount: deposit,
          depositPaid,
          depositPaidDate: depositPaid ? new Date() : null,
          bookingNumber: bookingNum,
          status: depositPaid ? 'confirmed' : 'pending',
          lineItems: { create: parsedLines }
        },
        include: { lineItems: true }
      });
      if (depositPaid) {
        await postLedgerEntry(tx, {
          customerId: customer.id, transactionType: 'booking_deposit', amount: -deposit,
          description: `Booking Deposit - ${bookingNum}`, referenceNumber: bookingNum,
        });
        await recordIncomeTx(tx, {
          companyId, incomeSource: 'booking_deposit', amount: deposit, paymentMethod: 'cash',
          referenceNumber: bookingNum, description: `Booking Deposit - ${bookingNum}`, depositAmount: deposit,
        });
      }
      return { newBooking, customerId: customer.id };
    }, { timeout: 20000 });
    if (depositPaid) await recalculateCustomerBalance(customerId, companyId);

    await logAudit(companyId, getActor(req), 'EMAIL_DISPATCH', 'Booking', newBooking.id, bookingNum,
      `Simulated booking confirmation email dispatched to ${customerName} (${contactInfo || 'no contact'}). Estimated Total: UGX ${estimatedTotal.toLocaleString()}, Deposit: UGX ${deposit.toLocaleString()}`);

    await createNotification({
      companyId, category: 'booking',
      title: `New booking: ${bookingNum}`,
      message: `${customerName} created a booking. Estimated total: ${(estimatedTotal || 0).toLocaleString()}.`,
      link: bookingNum,
    });

    res.status(201).json(newBooking);
  } catch (err: any) {
    if (err instanceof WorkflowError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Could not create the booking. Nothing was saved.' });
  }
});

// 6. Confirm Booking (collect the deposit if one is still owed).
// Explicit transitions, each recorded once:
//   pending + unpaid → confirmed + paid   (posts ONE ledger credit + income)
//   pending + paid   → confirmed          (legacy rows: no second receipt)
//   confirmed        → no-op (idempotent)
app.post('/api/bookings/:id/confirm-deposit', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findFirst({ where: { id, companyId } });
      if (!booking) throw new WorkflowError('Booking not found.', 404);
      if (booking.status === 'confirmed') return { booking, collected: 0, customerId: booking.customerId };
      if (booking.status !== 'pending') throw new WorkflowError(`A ${booking.status} booking cannot be confirmed.`);

      const customer = (booking.customerId ? await tx.customer.findFirst({ where: { id: booking.customerId, companyId } }) : null)
        ?? (await tx.customer.findFirst({ where: { companyId, name: booking.customerName.trim() } }))
        ?? await tx.customer.create({ data: { companyId, name: booking.customerName.trim(), contactInfo: booking.contactInfo || '', isOnWatchList: false } });

      // Conditional claim: only one concurrent request can make this transition.
      const claimed = await tx.booking.updateMany({
        where: { id, companyId, status: 'pending' },
        data: {
          status: 'confirmed', customerId: customer.id,
          ...(booking.depositPaid ? {} : { depositPaid: true, depositPaidDate: new Date() }),
        },
      });
      if (claimed.count !== 1) throw new WorkflowError('This booking was updated by someone else. Refresh and try again.', 409);

      const collected = booking.depositPaid ? 0 : Number(booking.depositAmount);
      if (collected > 0) {
        await postLedgerEntry(tx, {
          customerId: customer.id, transactionType: 'booking_deposit', amount: -collected,
          description: `Booking Deposit - ${booking.bookingNumber}`, referenceNumber: booking.bookingNumber,
        });
        await recordIncomeTx(tx, {
          companyId, incomeSource: 'booking_deposit', amount: collected, paymentMethod: 'cash',
          referenceNumber: booking.bookingNumber, description: `Booking Deposit - ${booking.bookingNumber}`, depositAmount: collected,
        });
      }
      const updated = await tx.booking.findUniqueOrThrow({ where: { id } });
      return { booking: updated, collected, customerId: customer.id };
    });

    const updated = outcome.booking;
    if (outcome.collected > 0 && outcome.customerId) {
      await recalculateCustomerBalance(outcome.customerId, companyId);
      const company = await prisma.company.findUnique({ where: { id: companyId } });
      await createNotification({
        companyId, category: 'payment',
        title: `Deposit received: ${updated.bookingNumber}`,
        message: `${updated.customerName} paid a deposit of ${company?.currencySymbol || ''} ${outcome.collected.toLocaleString()}.`,
        link: updated.bookingNumber,
      });
    }
    audit(req, 'DEPOSIT_CONFIRMED', 'Booking', updated.id, updated.bookingNumber,
      outcome.collected > 0
        ? `Deposit of ${outcome.collected.toLocaleString()} collected from ${updated.customerName}. Status → confirmed.`
        : `Booking confirmed for ${updated.customerName} (no new deposit collected).`);
    res.json(updated);
  } catch (err: any) {
    if (err instanceof WorkflowError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Could not confirm the booking. Nothing was changed.' });
  }
});

// 7. Dispatch Rental Order (Convert Booking)
// The booking claim, stock movements, rental order, invoice and ledger debit all
// commit in ONE transaction: dispatch either fully succeeds or leaves nothing
// behind, so a retry never meets a half-converted booking.
app.post('/api/bookings/:id/dispatch', async (req, res) => {
  const companyId = getCompanyId(req);
  const bookingId = parseInt(req.params.id);
  try {
    const booking = await prisma.booking.findFirst({ where: { id: bookingId, companyId }, include: { lineItems: true } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.status === 'converted') return res.status(409).json({ error: "Booking already dispatched." });
    if (!['pending', 'confirmed'].includes(booking.status)) return res.status(400).json({ error: `A ${booking.status} booking cannot be dispatched.` });
    if (booking.lineItems.length === 0) return res.status(400).json({ error: 'This booking has no lines to dispatch.' });

    const orderNum = makeReference('RO');
    const rentableQty = booking.lineItems.filter(li => li.itemType !== 'consumable').reduce((n, li) => n + li.quantity, 0);
    const rentalDays = booking.scheduledPickupDate && booking.scheduledReturnDate
      ? getDaysBetween(booking.scheduledPickupDate, booking.scheduledReturnDate)
      : undefined;

    const result = await prisma.$transaction(async (tx) => {
      // Claim the booking first: of two concurrent dispatches only one passes.
      const claim = await tx.booking.updateMany({
        where: { id: bookingId, companyId, status: { in: ['pending', 'confirmed'] } },
        data: { status: 'converted' },
      });
      if (claim.count !== 1) throw new WorkflowError('Booking already dispatched.', 409);

      const customer = (booking.customerId ? await tx.customer.findFirst({ where: { id: booking.customerId, companyId } }) : null)
        ?? (await tx.customer.findFirst({ where: { companyId, name: booking.customerName.trim() } }))
        ?? await tx.customer.create({ data: { companyId, name: booking.customerName.trim(), contactInfo: booking.contactInfo || '', isOnWatchList: false } });

      for (const li of booking.lineItems) {
        if (li.itemType === 'consumable' && li.consumableId) {
          const dbConsumable = await tx.consumable.findFirst({ where: { id: li.consumableId, companyId } });
          if (!dbConsumable) throw new WorkflowError(`Consumable item not found in catalog.`);
          const baseQty = (dbConsumable.isMultiUnit && li.unitOfMeasureId && li.unitOfMeasureId === dbConsumable.packageUnitId)
            ? li.quantity * dbConsumable.unitRatio
            : li.quantity;
          // Conditional decrement: never goes negative under concurrency.
          const took = await tx.consumable.updateMany({
            where: { id: dbConsumable.id, companyId, stockQty: { gte: baseQty } },
            data: { stockQty: { decrement: baseQty } },
          });
          if (took.count !== 1) throw new WorkflowError(`Insufficient stock for consumable "${dbConsumable.name}". Available: ${dbConsumable.stockQty}, Required: ${baseQty}`);
          await tx.consumableLog.create({
            data: {
              consumableId: dbConsumable.id, action: 'use', quantity: baseQty, operator: 'system',
              notes: `Sold ${li.quantity} ${li.unitOfMeasureId === dbConsumable.packageUnitId ? 'Big Unit' : 'Small Unit'} (${baseQty} base units) in Order #${orderNum} (Booking #${booking.bookingNumber})`
            }
          });
          const totalCost = Number(dbConsumable.costPrice) * baseQty;
          if (totalCost > 0) {
            await tx.expense.create({
              data: {
                companyId, amount: totalCost, expenseCategory: 'Cost of Goods Sold',
                expenseDate: new Date().toISOString().split('T')[0], paymentMethod: 'internal',
                notes: `COGS: ${li.quantity} x ${dbConsumable.name} (Sold in Order #${orderNum})`
              }
            });
          }
        } else if (li.itemType === 'item' && li.itemId) {
          const took = await tx.item.updateMany({
            where: { id: li.itemId, companyId, currentStock: { gte: li.quantity } },
            data: { currentStock: { decrement: li.quantity } },
          });
          if (took.count !== 1) {
            const dbItem = await tx.item.findFirst({ where: { id: li.itemId, companyId } });
            throw new WorkflowError(dbItem
              ? `Insufficient stock for "${dbItem.name}". Available: ${dbItem.currentStock}, Required: ${li.quantity}.`
              : 'Rental item not found in catalog.');
          }
        } else if (li.itemType === 'asset' && li.assetId) {
          // Claim the serialized unit: only an Available asset can go out.
          const took = await tx.serializedAsset.updateMany({
            where: { id: li.assetId, companyId, status: 'Available' },
            data: { status: 'Rented' },
          });
          if (took.count !== 1) {
            const asset = await tx.serializedAsset.findFirst({ where: { id: li.assetId, companyId } });
            throw new WorkflowError(asset
              ? `Asset "${asset.name}" (${asset.serialNumber}) is ${asset.status} and cannot be dispatched.`
              : 'Asset not found in catalog.');
          }
        } else {
          throw new WorkflowError(`Booking line ${li.id} has an unrecognised type "${li.itemType}".`);
        }
      }

      // Sale-only orders (consumables, nothing to bring back) are complete at
      // dispatch, so they never sit open or show as overdue.
      const saleOnly = rentableQty === 0;
      const now = new Date();
      const order = await tx.rentalOrder.create({
        data: {
          companyId,
          customerId: customer.id,
          customerName: booking.customerName,
          checkoutDate: now,
          expectedReturnDate: booking.scheduledReturnDate || now,
          status: saleOnly ? 'Returned' : 'Active',
          isFullyReconciled: saleOnly,
          actualReturnDate: saleOnly ? now : null,
          companyOrderNumber: orderNum,
          estimatedTotal: booking.estimatedTotalCost,
          totalAmountPaid: booking.depositAmount,
          lineItems: {
            create: booking.lineItems.map(li => ({
              itemType: li.itemType,
              itemId: li.itemId,
              assetId: li.assetId,
              consumableId: li.consumableId,
              unitOfMeasureId: li.unitOfMeasureId,
              quantity: li.quantity,
              dailyRate: li.dailyRateAtBooking,
              rentedQty: li.itemType === 'consumable' ? 0 : li.quantity // consumables are sold off and not expected back
            }))
          }
        }
      });

      await tx.booking.update({
        where: { id: bookingId },
        data: { customerId: customer.id, convertedRentalOrderId: order.id }
      });

      const account = await tx.customerAccount.findUnique({ where: { customerId: customer.id } });
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (account?.paymentTermsDays ?? 30));

      // Invoice for the whole order; a deposit already taken is recorded as paid
      // against it (the full supply is what URA fiscalizes).
      const orderInvoice = await createOrderInvoice(
        companyId, order.id, orderNum, customer.id, booking.customerName,
        dueDate, Number(booking.depositAmount) || 0, `Rental Order #${orderNum}`,
        { rentalDays, db: tx }
      );
      if (!orderInvoice) throw new WorkflowError('Could not raise the invoice for this order.', 500);

      // Charge the ledger exactly what was invoiced.
      await postLedgerEntry(tx, {
        customerId: customer.id, transactionType: 'invoice', amount: Number(orderInvoice.amount),
        description: `Rental Order #${orderNum}`, dueDate, referenceNumber: orderNum,
      });

      return { order, customerId: customer.id, invoiceId: orderInvoice.id };
    }, { timeout: 30000 });

    await recalculateCustomerBalance(result.customerId, companyId);
    for (const li of booking.lineItems) {
      if (li.itemType === 'item' && li.itemId) await checkItemLowStock(li.itemId, companyId);
    }

    audit(req, 'DISPATCH', 'RentalOrder', result.order.id, orderNum,
      `Dispatched Order #${orderNum} from Booking #${booking.bookingNumber} for ${booking.customerName}.`);
    res.status(201).json({ ...result.order, invoiceId: result.invoiceId });
  } catch (err: any) {
    if (err instanceof WorkflowError) return res.status(err.status).json({ error: err.message });
    console.error('[dispatch] failed:', err?.message);
    res.status(500).json({ error: 'Dispatch failed and was rolled back. Nothing was changed; it is safe to retry.' });
  }
});

// 8. Fetch Rental Orders
app.get('/api/rental-orders', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.rentalOrder.findMany({
      where: { companyId },
      include: {
        lineItems: {
          include: {
            item: true,
            asset: true,
            consumable: {
              include: {
                packageUnit: true,
                pieceUnit: true,
                unitOfMeasure: true
              }
            },
            unitOfMeasure: true
          }
        }
      }
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8b. Fetch overdue rental orders with days overdue computed
app.get('/api/rental-orders/overdue', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const now = new Date();
    const overdueOrders = await prisma.rentalOrder.findMany({
      where: {
        companyId,
        status: { in: ['Active', 'Overdue'] },
        expectedReturnDate: { lt: now },
        actualReturnDate: null
      },
      include: {
        lineItems: {
          include: {
            item: true,
            asset: true,
            consumable: {
              include: {
                packageUnit: true,
                pieceUnit: true,
                unitOfMeasure: true
              }
            },
            unitOfMeasure: true
          }
        }
      },
      orderBy: { expectedReturnDate: 'asc' }
    });

    const enriched = overdueOrders.map(order => {
      const daysOverdue = Math.max(0, Math.ceil(
        (now.getTime() - new Date(order.expectedReturnDate).getTime()) / (1000 * 60 * 60 * 24)
      ));
      // 10% of daily rate per day overdue for each line item
      const projectedLateFee = order.lineItems.reduce((sum, li) => {
        return sum + (Number(li.dailyRate) * 0.10 * daysOverdue * li.rentedQty);
      }, 0);
      return { ...order, daysOverdue, projectedLateFee: Math.round(projectedLateFee) };
    });

    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8c. Dashboard overdue summary (count + total projected fees)
app.get('/api/dashboard/overdue-alerts', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const now = new Date();
    const overdueOrders = await prisma.rentalOrder.findMany({
      where: {
        companyId,
        status: { in: ['Active', 'Overdue'] },
        expectedReturnDate: { lt: now },
        actualReturnDate: null
      },
      include: { lineItems: true }
    });

    let totalProjectedFees = 0;
    const overdueList = overdueOrders.map(order => {
      const daysOverdue = Math.max(0, Math.ceil(
        (now.getTime() - new Date(order.expectedReturnDate).getTime()) / (1000 * 60 * 60 * 24)
      ));
      const projectedLateFee = order.lineItems.reduce((sum, li) => {
        return sum + (Number(li.dailyRate) * 0.10 * daysOverdue * li.rentedQty);
      }, 0);
      totalProjectedFees += projectedLateFee;
      return {
        id: order.id,
        companyOrderNumber: order.companyOrderNumber,
        customerName: order.customerName,
        expectedReturnDate: order.expectedReturnDate,
        daysOverdue,
        projectedLateFee: Math.round(projectedLateFee)
      };
    });

    res.json({
      overdueCount: overdueOrders.length,
      totalProjectedFees: Math.round(totalProjectedFees),
      orders: overdueList.sort((a, b) => b.daysOverdue - a.daysOverdue)
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8d. Apply / recalculate late fee on a specific overdue order
app.post('/api/rental-orders/:id/apply-late-fee', async (req, res) => {
  const companyId = getCompanyId(req);
  const orderId = parseInt(req.params.id);
  try {
    const order = await prisma.rentalOrder.findFirst({
      where: { id: orderId, companyId },
      include: { lineItems: true, company: true }
    });
    if (!order) return res.status(404).json({ error: 'Rental order not found.' });

    const now = new Date();
    const refDate = order.actualReturnDate || now;
    // Shared formula + company-configurable rate (kept in sync with the return endpoint).
    const { lateFee, daysOverdue } = computeLateFee(
      order.lineItems, order.expectedReturnDate, refDate, Number(order.company.lateFeePercentPerDay)
    );

    const updated = await prisma.rentalOrder.update({
      where: { id: orderId },
      data: {
        totalLateFeeCalculated: lateFee,
        lateFeeAppliedAt: now,
        status: daysOverdue > 0 && !order.actualReturnDate ? 'Overdue' : order.status
      }
    });

    await logAudit(companyId, 'system', 'LATE_FEE_APPLIED', 'RentalOrder', orderId, order.companyOrderNumber,
      `Late fee of ${order.company.currencySymbol} ${lateFee.toLocaleString()} applied for ${daysOverdue} overdue day(s).`);

    // Idempotent ledger charge + penalty invoice (deterministic references).
    await chargeLedgerOnce(order.customerId, companyId, 'late_fee',
      `${order.companyOrderNumber}-LF`, lateFee,
      `Late return penalty on Order #${order.companyOrderNumber} (${daysOverdue} day(s))`, now);

    if (lateFee > 0) {
      await upsertPenaltyInvoice(companyId, `LFEE-${order.companyOrderNumber}`,
        order.customerName, lateFee,
        `Late return penalty — Order #${order.companyOrderNumber} — ${daysOverdue} day(s) overdue`, now,
        { customerId: order.customerId, rentalOrderId: order.id });
    }

    res.json({ ...updated, daysOverdue, lateFeeApplied: lateFee });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// 9. Process Rental Order Return with per-line reconciliation.
// Body: { lines?: [{ lineItemId, returnedQty, damagedQty, lostQty }], notes? }
// If `lines` is omitted, each line's full outstanding quantity is treated as
// returned in good condition (backward-compatible one-click "return all").
//
// Fees are read from the company's configurable policy (Settings):
//   • late fee  = Σ dailyRate × lateFeePercentPerDay% × daysOverdue × rentedQty
//   • damage fee = Σ damagedQty × replacementCost × damageFeePercent%
//   • lost fee   = Σ lostQty    × replacementCost × lostFeePercent%
app.post('/api/rental-orders/:id/return', async (req, res) => {
  const id = parseInt(req.params.id);
  const companyId = getCompanyId(req);
  const actor = getActor(req);
  const { lines, notes } = req.body || {};
  try {
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const damagePct = Number(company.damageFeePercent) / 100;
    const lostPct = Number(company.lostFeePercent) / 100;
    const restock = company.restockReturnedItems;
    const now = new Date();

    const inputById = new Map<number, { returnedQty: number; damagedQty: number; lostQty: number }>();
    if (Array.isArray(lines)) {
      for (const l of lines) {
        inputById.set(Number(l.lineItemId), {
          returnedQty: Math.max(0, parseInt(l.returnedQty) || 0),
          damagedQty: Math.max(0, parseInt(l.damagedQty) || 0),
          lostQty: Math.max(0, parseInt(l.lostQty) || 0),
        });
      }
    }

    // Everything — line quantities, stock, the immutable return event, its
    // charge invoice and ledger rows, and the order totals — commits together.
    const outcome = await prisma.$transaction(async (tx) => {
      // Serialise concurrent reconciliations of the same order.
      await tx.$queryRaw`SELECT id FROM rental_orders WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`;
      const order = await tx.rentalOrder.findFirst({
        where: { id, companyId },
        include: { lineItems: { include: { item: true, asset: true } } }
      });
      if (!order) throw new WorkflowError('Rental order not found.', 404);
      const openStatuses = ['Active', 'Overdue', 'Partially Returned'];
      if (!openStatuses.includes(order.status)) throw new WorkflowError('Rental order is already returned/finalized.');

      let damageFee = 0, lostFee = 0;
      const recLines: Array<{ li: any; inp: { returnedQty: number; damagedQty: number; lostQty: number } }> = [];
      for (const li of order.lineItems) {
        if (li.itemType === 'consumable') continue; // sold off, never expected back
        const outstanding = (li.rentedQty || 0) - (li.returnedQty + li.damagedQty + li.lostQty);
        if (outstanding <= 0) continue;
        const inp = inputById.get(li.id) || { returnedQty: outstanding, damagedQty: 0, lostQty: 0 };
        const total = inp.returnedQty + inp.damagedQty + inp.lostQty;
        if (total > outstanding) {
          throw new WorkflowError(`Line item ${li.id}: reconciled quantity (${total}) exceeds outstanding rented quantity (${outstanding}).`);
        }
        if (total === 0) continue;
        const replacementUnit = li.itemType === 'asset'
          ? Number(li.asset?.replacementCost || 0)
          : Number(li.item?.unitReplacementCost || 0);
        damageFee += inp.damagedQty * replacementUnit * damagePct;
        lostFee += inp.lostQty * replacementUnit * lostPct;
        recLines.push({ li, inp });
      }
      if (recLines.length === 0) throw new WorkflowError('Nothing to reconcile — all rented items are already accounted for.');

      damageFee = Math.round(damageFee);
      lostFee = Math.round(lostFee);
      const eventFee = damageFee + lostFee;

      for (const { li, inp } of recLines) {
        await tx.rentalLineItem.update({
          where: { id: li.id },
          data: {
            returnedQty: { increment: inp.returnedQty },
            damagedQty: { increment: inp.damagedQty },
            lostQty: { increment: inp.lostQty },
          }
        });
        if (li.itemType === 'asset' && li.assetId) {
          let status: string | null = null;
          if (inp.lostQty > 0) status = 'Lost';
          else if (inp.damagedQty > 0) status = 'Maintenance';
          else if (restock) status = 'Available';
          if (status) await tx.serializedAsset.updateMany({ where: { id: li.assetId, companyId }, data: { status } });
        } else if (li.itemType === 'item' && li.itemId) {
          // Good returns go back on hand; damaged/lost units stay out.
          if (restock && inp.returnedQty > 0) {
            await tx.item.updateMany({ where: { id: li.itemId, companyId }, data: { currentStock: { increment: inp.returnedQty } } });
          }
        }
      }

      let fullyReconciled = true;
      for (const li of order.lineItems) {
        if (li.itemType === 'consumable') continue;
        const applied = recLines.find(r => r.li.id === li.id)?.inp;
        const accounted = li.returnedQty + li.damagedQty + li.lostQty
          + (applied ? applied.returnedQty + applied.damagedQty + applied.lostQty : 0);
        if (accounted < (li.rentedQty || 0)) fullyReconciled = false;
      }

      // Late fees accrue on the whole order up to now; never reduce a fee
      // already charged.
      const computed = computeLateFee(order.lineItems, order.expectedReturnDate, now, Number(company.lateFeePercentPerDay));
      const lateFee = Math.max(computed.lateFee, Math.round(Number(order.totalLateFeeCalculated) || 0));
      const daysOverdue = computed.daysOverdue;

      // Damage/loss: this submission's charges are a NEW event with its own
      // invoice and ledger row. The order total is the sum over all events, so
      // a later partial or clean return can never overwrite earlier charges.
      // Orders reconciled before return events existed already carry a DMG
      // invoice for their earlier charges; number past it so it's never touched.
      const priorEvents = await tx.returnEvent.count({ where: { rentalOrderId: id } });
      const legacyCharge = priorEvents === 0 && Number(order.totalReplacementFeeCalculated) > 0 ? 1 : 0;
      const sequence = priorEvents + legacyCharge + 1;
      let eventInvoiceId: number | null = null;
      if (eventFee > 0) {
        const ref = sequence === 1 ? `DMG-${order.companyOrderNumber}` : `DMG-${order.companyOrderNumber}-${sequence}`;
        const inv = await upsertPenaltyInvoice(companyId, ref, order.customerName, eventFee,
          `Damage & loss recovery — Order #${order.companyOrderNumber}${sequence > 1 ? ` (return ${sequence})` : ''}`, now,
          { customerId: order.customerId, rentalOrderId: order.id, db: tx });
        eventInvoiceId = inv.id;
        await postLedgerEntry(tx, {
          customerId: order.customerId, transactionType: 'damage_fee', amount: eventFee,
          description: `Damage/loss recovery on Order #${order.companyOrderNumber}${sequence > 1 ? ` (return ${sequence})` : ''}`,
          dueDate: now, referenceNumber: `${order.companyOrderNumber}-DF${sequence > 1 ? `-${sequence}` : ''}`,
        });
      }
      await tx.returnEvent.create({
        data: {
          companyId, rentalOrderId: id, sequence,
          returnedQty: recLines.reduce((n, r) => n + r.inp.returnedQty, 0),
          damagedQty: recLines.reduce((n, r) => n + r.inp.damagedQty, 0),
          lostQty: recLines.reduce((n, r) => n + r.inp.lostQty, 0),
          damageFee, lostFee, invoiceId: eventInvoiceId,
          lines: recLines.map(r => ({ lineItemId: r.li.id, ...r.inp })),
          notes: notes ? String(notes) : null, createdBy: actor,
        },
      });

      // Late fee: one cumulative charge per order (deterministic reference). The
      // invoice helper never rewrites a paid/credited/fiscalized invoice; it bills
      // any increase as a supplementary invoice instead.
      if (lateFee > 0) {
        const lfRef = `${order.companyOrderNumber}-LF`;
        const account = await tx.customerAccount.findUnique({ where: { customerId: order.customerId } });
        if (account) await tx.customerAccountTransaction.deleteMany({ where: { accountId: account.id, transactionType: 'late_fee', referenceNumber: lfRef } });
        await postLedgerEntry(tx, {
          customerId: order.customerId, transactionType: 'late_fee', amount: lateFee,
          description: `Late return penalty on Order #${order.companyOrderNumber} (${daysOverdue} day(s))`,
          dueDate: now, referenceNumber: lfRef,
        });
        await upsertPenaltyInvoice(companyId, `LFEE-${order.companyOrderNumber}`, order.customerName, lateFee,
          `Late return penalty — Order #${order.companyOrderNumber} — ${daysOverdue} day(s) overdue`, now,
          { customerId: order.customerId, rentalOrderId: order.id, db: tx });
      }

      const replacementTotal = Math.round(Number(order.totalReplacementFeeCalculated) || 0) + eventFee;
      const updated = await tx.rentalOrder.update({
        where: { id },
        data: {
          status: fullyReconciled ? 'Returned' : 'Partially Returned',
          actualReturnDate: fullyReconciled ? now : order.actualReturnDate,
          totalLateFeeCalculated: lateFee,
          totalReplacementFeeCalculated: replacementTotal,
          isFullyReconciled: fullyReconciled,
        }
      });
      return { order, updated, recLines, lateFee, eventFee, replacementTotal, daysOverdue, sequence };
    }, { timeout: 30000 });

    const { order, updated, recLines, lateFee, eventFee, replacementTotal, daysOverdue } = outcome;
    await recalculateCustomerBalance(order.customerId, companyId);

    await logAudit(companyId, actor, 'RETURN_RECONCILED', 'RentalOrder', order.id, order.companyOrderNumber,
      `Return #${outcome.sequence} reconciled — status: ${updated.status}. Late fee: ${company.currencySymbol} ${lateFee.toLocaleString()}, Damage/loss this return: ${company.currencySymbol} ${eventFee.toLocaleString()} (order total ${replacementTotal.toLocaleString()}).${notes ? ' Notes: ' + notes : ''}`);

    const damagedLost = recLines.reduce((n, r) => n + r.inp.damagedQty + r.inp.lostQty, 0);
    await createNotification({
      companyId, category: 'return',
      title: `Return processed: Order #${order.companyOrderNumber}`,
      message: damagedLost > 0
        ? `${order.customerName}'s return reconciled with ${damagedLost} damaged/lost unit(s). Recovery charged: ${company.currencySymbol} ${eventFee.toLocaleString()}.`
        : `${order.customerName}'s return reconciled cleanly (${updated.status}).`,
      link: order.companyOrderNumber,
    });

    for (const { li } of recLines) {
      if (li.itemType === 'item' && li.itemId) await checkItemLowStock(li.itemId, companyId);
    }

    res.json({ ...updated, lateFee, replacementFee: replacementTotal, eventReplacementFee: eventFee, daysOverdue });
  } catch (err: any) {
    if (err instanceof WorkflowError) return res.status(err.status).json({ error: err.message });
    console.error('[return] failed:', err?.message);
    res.status(500).json({ error: 'Return could not be recorded and was rolled back. Nothing was changed.' });
  }
});

// Reconciliation register: orders with recorded damage/loss or an incomplete
// return (partially returned / still-outstanding units). Feeds the Alerts view.
app.get('/api/reconciliations', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const orders = await prisma.rentalOrder.findMany({
      where: { companyId },
      include: { lineItems: { include: { item: true, asset: true } } },
      orderBy: { checkoutDate: 'desc' }
    });

    const register = orders
      .map(o => {
        const rentable = o.lineItems.filter(li => li.itemType !== 'consumable');
        const rented = rentable.reduce((s, li) => s + (li.rentedQty || 0), 0);
        const returned = rentable.reduce((s, li) => s + li.returnedQty, 0);
        const damaged = rentable.reduce((s, li) => s + li.damagedQty, 0);
        const lost = rentable.reduce((s, li) => s + li.lostQty, 0);
        const outstanding = rented - returned - damaged - lost;
        return {
          id: o.id,
          companyOrderNumber: o.companyOrderNumber,
          customerName: o.customerName,
          status: o.status,
          checkoutDate: o.checkoutDate,
          expectedReturnDate: o.expectedReturnDate,
          actualReturnDate: o.actualReturnDate,
          isFullyReconciled: o.isFullyReconciled,
          totalLateFeeCalculated: Number(o.totalLateFeeCalculated),
          totalReplacementFeeCalculated: Number(o.totalReplacementFeeCalculated),
          rented, returned, damaged, lost, outstanding,
        };
      })
      // Only surface rows that need attention: any damage/loss, or an unfinished return.
      .filter(r => r.damaged > 0 || r.lost > 0 || r.status === 'Partially Returned' ||
        (r.status !== 'Returned' && r.status !== 'Cancelled' && r.outstanding > 0 && r.rented > 0));

    res.json(register);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Fetch Invoices
app.get('/api/invoices', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.invoice.findMany({
      where: { companyId },
      include: INVOICE_INCLUDE,
      orderBy: { id: 'desc' }
    });
    res.json(list.map(decorateInvoice));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// A single invoice with everything needed to print, pay or fiscalize it.
app.get('/api/invoices/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: parseInt(req.params.id), companyId },
      include: INVOICE_INCLUDE
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    res.json(withInvoiceSummary(invoice));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── SERVER-SIDE PDF DOCUMENTS ──────────────────────────────────────────────

// Downloadable invoice PDF
app.get('/api/invoices/:id/pdf', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: parseInt(req.params.id), companyId },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } }
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found.' });
    streamInvoicePdf(res, company, invoice as any);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Downloadable booking / deposit receipt PDF
app.get('/api/bookings/:id/receipt-pdf', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const booking = await prisma.booking.findFirst({ where: { id: parseInt(req.params.id), companyId } });
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found.' });
    streamBookingReceiptPdf(res, company, booking as any);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Downloadable rental-order / dispatch note PDF
app.get('/api/rental-orders/:id/pdf', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const order = await prisma.rentalOrder.findFirst({
      where: { id: parseInt(req.params.id), companyId },
      include: { lineItems: { include: { item: true, asset: true, consumable: true } } }
    });
    if (!order) return res.status(404).json({ error: 'Rental order not found.' });
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found.' });
    streamRentalOrderPdf(res, company, order as any);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// 11. Issue Credit Note
app.post('/api/invoices/:id/credit-memo', async (req, res) => {
  const id = parseInt(req.params.id);
  // `lines` credits specific quantities of specific invoice lines; omitting it
  // reverses the whole invoice. `reasonCode` is URA's credit-note reason (§5).
  const { reason, reasonCode, lines } = req.body;
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } }
    });

    if (!invoice) return res.status(404).json({ error: "Invoice not found." });

    const selection = Array.isArray(lines) && lines.length
      ? lines.map((l: any) => ({ lineId: parseInt(l.lineId), quantity: Number(l.quantity) }))
      : undefined;
    const credited = creditNoteLinesFromInvoice(invoice.lineItems as any, selection);
    if (credited.rows.length === 0 || credited.amount <= 0) {
      return res.status(400).json({ error: 'Nothing to credit — the selected lines came to zero.' });
    }
    class CreditRejected extends Error {}
    const result = await prisma.$transaction(async (tx) => {
      // Re-read inside the transaction: credits are cumulative and must never
      // exceed the invoice's face value in total.
      const current = await tx.invoice.findUniqueOrThrow({ where: { id } });
      const creditable = round2(Number(current.amount) - Number(current.amountCredited));
      if (credited.amount > creditable + 0.01) {
        throw new CreditRejected(creditable <= 0
          ? `Invoice ${invoice.referenceNumber} has already been fully credited.`
          : `A credit of ${credited.amount.toLocaleString()} exceeds the ${creditable.toLocaleString()} that can still be credited on this invoice.`);
      }
      const priorNotes = await tx.creditNote.count({ where: { invoiceId: invoice.id } });
      const creditNoteNum = (priorNotes === 0 ? `CN-${invoice.referenceNumber}` : `CN-${invoice.referenceNumber}-${priorNotes + 1}`).slice(0, 100);

      const note = await tx.creditNote.create({
        data: {
          companyId: invoice.companyId,
          referenceNumber: creditNoteNum,
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          customerName: invoice.customerName,
          subtotal: credited.subtotal,
          taxTotal: credited.taxTotal,
          amount: credited.amount,
          reason: reason || "Billing adjustment",
          reasonCode: creditNoteReasonCode(reasonCode),
          createdAt: new Date(),
          lineItems: { create: credited.rows }
        },
        include: { lineItems: true }
      });

      // Credits reduce what is collectible; they are NOT cash received, so
      // amountPaid is left untouched. Status follows from the figures.
      const amountCredited = round2(Number(current.amountCredited) + Math.min(credited.amount, creditable));
      await tx.invoice.update({
        where: { id },
        data: { amountCredited, status: deriveInvoiceStatus({ ...current, amountCredited }) },
      });

      const customerId = invoice.customerId
        ?? (await tx.customer.findFirst({ where: { companyId: invoice.companyId, name: invoice.customerName.trim() } }))?.id
        ?? (await tx.customer.create({ data: { companyId: invoice.companyId, name: invoice.customerName.trim(), contactInfo: '', isOnWatchList: false } })).id;
      await postLedgerEntry(tx, {
        customerId, transactionType: 'credit_memo', amount: -credited.amount,
        description: `Credit Memo - ${creditNoteNum} (${reason || 'Billing adjustment'})`,
        referenceNumber: creditNoteNum,
      });
      return { note, customerId, creditNoteNum };
    }).catch((err: any) => {
      if (err instanceof CreditRejected) { res.status(400).json({ error: err.message }); return null; }
      throw err;
    });
    if (!result) return;
    await recalculateCustomerBalance(result.customerId, invoice.companyId);
    const creditNoteNum = result.creditNoteNum;

    audit(req, 'CREDIT_MEMO', 'Invoice', invoice.id, invoice.referenceNumber,
      `Credit note ${creditNoteNum} issued against invoice ${invoice.referenceNumber} (${credited.amount.toLocaleString()}) — ${reason || 'Billing adjustment'}.`);

    // Credit notes only reach URA when the invoice they reverse was fiscalized.
    let efris: any = null;
    if (invoice.efrisFDN) {
      try {
        efris = await fiscalizeCreditNote(invoice.companyId, result.note.id, getActor(req));
      } catch (err: any) {
        efris = { status: 'FAILED', error: err.message };
      }
    }

    res.status(201).json({ ...result.note, efris });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

class PaymentRejected extends Error {}

app.post('/api/invoices/:id/pay', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { paymentMethod, paymentDate, notes, amount } = req.body;
  if (!paymentMethod || !paymentDate) {
    return res.status(400).json({ error: 'paymentMethod and paymentDate are required.' });
  }
  const paidOn = new Date(paymentDate);
  if (isNaN(paidOn.getTime())) return res.status(400).json({ error: 'paymentDate is not a valid date.' });
  // Identifies this payment. The client sends one key per payment it means to
  // record; a replay (double click, retry after a timeout) reuses the key and is
  // answered with the original result instead of posting again.
  const rawKey = typeof req.body.paymentKey === 'string' ? req.body.paymentKey.trim() : '';
  if (rawKey && !/^[A-Za-z0-9_.:-]{8,100}$/.test(rawKey)) return res.status(400).json({ error: 'Invalid paymentKey.' });
  const paymentKey = rawKey || `srv-${makeToken().slice(0, 32)}`;
  const actor = getActor(req);

  try {
    const replay = await prisma.invoicePayment.findUnique({ where: { companyId_paymentKey: { companyId, paymentKey } } });
    if (replay) {
      if (replay.invoiceId !== id) return res.status(409).json({ error: 'This payment key was already used for another invoice.' });
      const inv = await prisma.invoice.findUnique({ where: { id } });
      return res.json({ ...decorateInvoice(inv), replayed: true, payment: replay });
    }

    const result = await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findFirst({ where: { id, companyId } });
      if (!invoice) throw new PaymentRejected('Invoice not found.');
      if (!OPEN_INVOICE_STATUSES.includes(invoice.status)) {
        throw new PaymentRejected(`This invoice is ${invoice.status} and cannot take a payment.`);
      }
      // An omitted amount settles the whole collectible balance (cash AND credits
      // already applied are excluded). Over-collection is rejected, not trimmed.
      const outstanding = collectibleBalance(invoice);
      if (outstanding <= 0) throw new PaymentRejected('This invoice has nothing outstanding.');
      const paying = amount !== undefined && amount !== null && amount !== '' ? round2(Number(amount)) : outstanding;
      if (!(paying > 0)) throw new PaymentRejected('Payment amount must be greater than zero.');
      if (paying > outstanding + 0.005) {
        throw new PaymentRejected(`Payment of ${paying.toLocaleString()} exceeds the outstanding balance of ${outstanding.toLocaleString()}.`);
      }

      // Atomic, concurrency-safe increment: succeeds only while the balance still
      // covers this payment, so two simultaneous payments can't both read the
      // same balance and overpay.
      const applied: number = await tx.$executeRaw`
        UPDATE invoices
           SET amount_paid = amount_paid + ${paying},
               payment_method = ${String(paymentMethod)},
               payment_date = ${paidOn},
               payment_notes = ${String(notes || '').slice(0, 255)}
         WHERE id = ${id} AND company_id = ${companyId}
           AND amount - amount_paid - amount_credited >= ${paying - 0.005}`;
      if (applied !== 1) throw new PaymentRejected('The invoice balance changed while posting this payment. Refresh and try again.');

      const fresh = await tx.invoice.findUniqueOrThrow({ where: { id } });
      const updated = await tx.invoice.update({ where: { id }, data: { status: deriveInvoiceStatus(fresh) } });

      const payment = await tx.invoicePayment.create({
        data: { companyId, invoiceId: id, paymentKey, amount: paying, paymentMethod: String(paymentMethod),
          paymentDate: paidOn, notes: notes ? String(notes).slice(0, 255) : null, createdBy: actor },
      });

      const customerId = invoice.customerId
        ?? (await tx.customer.findFirst({ where: { companyId, name: invoice.customerName.trim() } }))?.id
        ?? (await tx.customer.create({ data: { companyId, name: invoice.customerName.trim(), contactInfo: '', isOnWatchList: false } })).id;
      await postLedgerEntry(tx, {
        customerId, transactionType: 'payment', amount: -paying,
        description: `Invoice Payment - ${invoice.referenceNumber} (${paymentMethod})`,
        referenceNumber: `${invoice.referenceNumber}-PAY${payment.id}`,
      });
      await recordIncomeTx(tx, {
        companyId, incomeSource: 'invoice_payment', amount: paying, paymentMethod: String(paymentMethod),
        referenceNumber: invoice.referenceNumber,
        description: `Invoice Payment - ${invoice.referenceNumber} (${paymentMethod})`,
        baseRentalAmount: paying,
      });
      return { invoice, updated, payment, paying, customerId };
    });

    // Derived data and notifications (safe to run after commit).
    await recalculateCustomerBalance(result.customerId, companyId);
    const { invoice, updated, paying } = result;
    const remaining = collectibleBalance(updated);
    await logAudit(companyId, actor, 'INVOICE_PAYMENT', 'Invoice', invoice.id, invoice.referenceNumber,
      `Payment of ${paying.toLocaleString()} via ${paymentMethod} recorded${remaining > 0 ? `; ${remaining.toLocaleString()} still outstanding` : ''}. notes: ${notes || 'none'}`);
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    await createNotification({
      companyId, category: 'payment',
      title: `Payment received: ${invoice.referenceNumber}`,
      message: `${invoice.customerName} paid ${company?.currencySymbol || ''} ${paying.toLocaleString()} via ${paymentMethod}${remaining > 0 ? `, leaving ${remaining.toLocaleString()} outstanding` : ''}.`,
      link: invoice.referenceNumber,
    });

    res.json({ ...decorateInvoice(updated), payment: result.payment });
  } catch (err: any) {
    if (err instanceof PaymentRejected) return res.status(400).json({ error: err.message });
    // Lost a race with a concurrent replay of the same key.
    if (err?.code === 'P2002') {
      const replay = await prisma.invoicePayment.findUnique({ where: { companyId_paymentKey: { companyId, paymentKey } } });
      if (replay && replay.invoiceId === id) {
        const inv = await prisma.invoice.findUnique({ where: { id } });
        return res.json({ ...decorateInvoice(inv), replayed: true, payment: replay });
      }
    }
    res.status(500).json({ error: 'Payment was not recorded. Nothing was posted; please try again.' });
  }
});

// CSV Export Customers
app.get('/api/export/customers', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.customer.findMany({
      where: { companyId }
    });
    let csv = 'id,name,contactInfo,watchListReason,isOnWatchList\n';
    list.forEach(c => {
      const name = `"${c.name.replace(/"/g, '""')}"`;
      const contact = `"${(c.contactInfo || '').replace(/"/g, '""')}"`;
      const reason = `"${(c.watchListReason || '').replace(/"/g, '""')}"`;
      csv += `${c.id},${name},${contact},${reason},${c.isOnWatchList}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=customers.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// CSV Export Catalog Items
app.get('/api/export/items', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.item.findMany({
      where: { companyId }
    });
    let csv = 'name,category,unitOfMeasure,unitCost,unitReplacementCost,dailyRentalRate,currentStock,lowStockThreshold\n';
    list.forEach(i => {
      const name = `"${i.name.replace(/"/g, '""')}"`;
      const category = `"${i.category.replace(/"/g, '""')}"`;
      csv += `${name},${category},${i.unitOfMeasure},${i.unitCost},${i.unitReplacementCost},${i.dailyRentalRate},${i.currentStock},${i.lowStockThreshold}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=items.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk Import Customers
app.post('/api/import/customers', async (req, res) => {
  const companyId = getCompanyId(req);
  const { data } = req.body;
  if (!Array.isArray(data)) {
    return res.status(400).json({ error: 'data array is required.' });
  }
  try {
    const created = await prisma.customer.createMany({
      data: data.map((c: any) => ({
        companyId,
        name: c.name || 'Unnamed Customer',
        contactInfo: c.contactInfo || '',
        isOnWatchList: c.isOnWatchList === true || c.isOnWatchList === 'true',
        watchListReason: c.watchListReason || ''
      }))
    });
    audit(req, 'IMPORT', 'Customer', null, `${created.count} records`, `Bulk import: ${created.count} customer(s).`);
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Bulk Import Catalog Items
app.post('/api/import/items', async (req, res) => {
  const companyId = getCompanyId(req);
  const { data } = req.body;
  if (!Array.isArray(data)) {
    return res.status(400).json({ error: 'data array is required.' });
  }
  try {
    const created = await prisma.item.createMany({
      data: data.map((i: any) => ({
        companyId,
        name: i.name || 'Unnamed Item',
        category: i.category || 'General',
        unitOfMeasure: i.unitOfMeasure || 'piece',
        unitCost: Number(i.unitCost || 0),
        unitReplacementCost: Number(i.unitReplacementCost || 0),
        dailyRentalRate: Number(i.dailyRentalRate || 0),
        currentStock: parseInt(i.currentStock || '0'),
        lowStockThreshold: parseInt(i.lowStockThreshold || '5')
      }))
    });
    audit(req, 'IMPORT', 'Item', null, `${created.count} records`, `Bulk import: ${created.count} bulk item(s).`);
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Helper: CSV-escape a value
function csvCell(v: any): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

// ── SERIALIZED ASSETS import / export ──────────────────────────────────────
app.get('/api/export/assets', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.serializedAsset.findMany({ where: { companyId } });
    let csv = 'name,assetType,serialNumber,costPrice,dailyRentalRate,replacementCost,status\n';
    list.forEach(a => {
      csv += `${csvCell(a.name)},${csvCell(a.assetType)},${csvCell(a.serialNumber)},${a.costPrice},${a.dailyRentalRate},${a.replacementCost},${csvCell(a.status)}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=assets.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import/assets', async (req, res) => {
  const companyId = getCompanyId(req);
  const { data } = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'data array is required.' });
  try {
    const created = await prisma.serializedAsset.createMany({
      data: data.map((a: any) => ({
        companyId,
        name: a.name || 'Unnamed Asset',
        assetType: a.assetType || 'General',
        serialNumber: a.serialNumber || `SN-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        costPrice: Number(a.costPrice || 0),
        dailyRentalRate: Number(a.dailyRentalRate || 0),
        replacementCost: Number(a.replacementCost || 0),
        status: a.status || 'Available',
      }))
    });
    audit(req, 'IMPORT', 'SerializedAsset', null, `${created.count} records`, `Bulk import: ${created.count} serialized asset(s).`);
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── CONSUMABLES import / export ────────────────────────────────────────────
app.get('/api/export/consumables', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.consumable.findMany({ where: { companyId } });
    let csv = 'name,category,stockQty,restockLevel,unitPrice,costPrice,sku\n';
    list.forEach(c => {
      csv += `${csvCell(c.name)},${csvCell(c.category)},${c.stockQty},${c.restockLevel},${c.unitPrice},${c.costPrice},${csvCell(c.sku)}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=consumables.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import/consumables', async (req, res) => {
  const companyId = getCompanyId(req);
  const { data } = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'data array is required.' });
  try {
    const created = await prisma.consumable.createMany({
      data: data.map((c: any) => ({
        companyId,
        name: c.name || 'Unnamed Consumable',
        category: c.category || 'general',
        stockQty: parseInt(c.stockQty || '0'),
        restockLevel: parseInt(c.restockLevel || '0'),
        unitPrice: Number(c.unitPrice || 0),
        costPrice: Number(c.costPrice || 0),
        sku: c.sku || null,
      }))
    });
    audit(req, 'IMPORT', 'Consumable', null, `${created.count} records`, `Bulk import: ${created.count} consumable(s).`);
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── EMPLOYEES import / export ──────────────────────────────────────────────
app.get('/api/export/employees', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.employee.findMany({ where: { companyId } });
    let csv = 'name,role,billingRateToClient,payStructure,payRate,isActive\n';
    list.forEach(e => {
      csv += `${csvCell(e.name)},${csvCell(e.role)},${e.billingRateToClient},${csvCell(e.payStructure)},${e.payRate},${e.isActive}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=employees.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import/employees', async (req, res) => {
  const companyId = getCompanyId(req);
  const { data } = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'data array is required.' });
  try {
    const created = await prisma.employee.createMany({
      data: data.map((e: any) => ({
        companyId,
        name: e.name || 'Unnamed Employee',
        role: e.role || null,
        billingRateToClient: Number(e.billingRateToClient || 0),
        payStructure: e.payStructure || 'Per Function',
        payRate: Number(e.payRate || 0),
        isActive: e.isActive === undefined ? true : (e.isActive === true || String(e.isActive).toLowerCase() === 'true'),
      }))
    });
    audit(req, 'IMPORT', 'Employee', null, `${created.count} records`, `Bulk import: ${created.count} staff member(s).`);
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 12. Fetch Credit Notes
app.get('/api/credit-notes', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.creditNote.findMany({
      where: { companyId },
      include: {
        lineItems: true,
        invoice: { select: { id: true, referenceNumber: true, efrisFDN: true } },
      },
      orderBy: { id: 'desc' }
    });
    res.json(list.map(n => ({
      ...n,
      isFiscalized: !!n.efrisFDN,
      reasonLabel: CREDIT_NOTE_REASONS[n.reasonCode] || 'Others',
      // A credit note can only reach URA if the invoice it reverses got there first.
      canFiscalize: !n.efrisFDN && !!n.invoice?.efrisFDN,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 12.5 Dashboard Stats (Dynamic Analytics Report)
app.get('/api/reports/dashboard-stats', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const { startDate, endDate, category, customerName } = req.query;

    const start = startDate ? new Date(startDate as string) : null;
    const end = endDate ? new Date(endDate as string) : null;
    const cat = category ? (category as string).toLowerCase() : null;
    const cust = customerName ? (customerName as string).toLowerCase() : null;

    // 1. Fetch matching rental orders for Active Rental Income
    const rentalOrders = await prisma.rentalOrder.findMany({
      where: { companyId },
      include: {
        lineItems: {
          include: {
            item: true,
            asset: true
          }
        }
      }
    });

    let filteredOrders = rentalOrders;
    if (start) {
      filteredOrders = filteredOrders.filter(o => new Date(o.checkoutDate) >= start);
    }
    if (end) {
      filteredOrders = filteredOrders.filter(o => new Date(o.checkoutDate) <= end);
    }
    if (cust) {
      filteredOrders = filteredOrders.filter(o => o.customerName.toLowerCase().includes(cust));
    }
    if (cat) {
      filteredOrders = filteredOrders.filter(o => 
        o.lineItems.some(li => 
          (li.item && li.item.category.toLowerCase() === cat) ||
          (li.asset && li.asset.assetType.toLowerCase() === cat)
        )
      );
    }

    const activeRentalIncome = filteredOrders.reduce((sum, o) => sum + Number(o.estimatedTotal), 0);

    // 2. Fetch deposits collected
    const bookings = await prisma.booking.findMany({
      where: {
        companyId,
        depositPaid: true
      },
      include: {
        lineItems: {
          include: {
            item: true,
            asset: true
          }
        }
      }
    });

    let filteredBookings = bookings;
    if (start) {
      filteredBookings = filteredBookings.filter(b => b.depositPaidDate && new Date(b.depositPaidDate) >= start);
    }
    if (end) {
      filteredBookings = filteredBookings.filter(b => b.depositPaidDate && new Date(b.depositPaidDate) <= end);
    }
    if (cust) {
      filteredBookings = filteredBookings.filter(b => b.customerName.toLowerCase().includes(cust));
    }
    if (cat) {
      filteredBookings = filteredBookings.filter(b =>
        b.lineItems.some(li => 
          (li.item && li.item.category.toLowerCase() === cat) ||
          (li.asset && li.asset.assetType.toLowerCase() === cat)
        )
      );
    }

    const depositsCollected = filteredBookings.reduce((sum, b) => sum + Number(b.depositAmount), 0);

    // 3. Fetch outstanding invoices
    // Every open invoice contributes what is still collectible on it (face value
    // less cash and credits), whether part of it came from a deposit or a later
    // part-payment.
    const invoices = await prisma.invoice.findMany({
      where: { companyId, status: { in: OPEN_INVOICE_STATUSES } }
    });

    let filteredInvoices = invoices;
    if (start) {
      filteredInvoices = filteredInvoices.filter(i => new Date(i.dueDate) >= start);
    }
    if (end) {
      filteredInvoices = filteredInvoices.filter(i => new Date(i.dueDate) <= end);
    }
    if (cust) {
      filteredInvoices = filteredInvoices.filter(i => i.customerName.toLowerCase().includes(cust));
    }

    const outstandingInvoices = round2(filteredInvoices.reduce((sum, i) => sum + collectibleBalance(i), 0));

    // 4. Fetch asset utilization
    let assetWhere: any = { companyId };
    if (cat) {
      assetWhere.assetType = { equals: category as string };
    }
    const totalAssets = await prisma.serializedAsset.count({
      where: assetWhere
    });
    const rentedAssets = await prisma.serializedAsset.count({
      where: {
        ...assetWhere,
        status: 'Rented'
      }
    });

    const assetUtilization = totalAssets > 0 ? (rentedAssets / totalAssets) * 100 : 0.0;

    // 5. Build dynamic utilization chart from database
    const itemsList = await prisma.item.findMany({
      where: { companyId }
    });
    const activeRentalLineItems = await prisma.rentalLineItem.findMany({
      where: {
        order: {
          status: 'Active',
          companyId
        }
      }
    });

    let utilizationChart = itemsList.map(item => {
      const itemLines = activeRentalLineItems.filter(li => li.itemId === item.id);
      const totalRented = itemLines.reduce((sum, li) => sum + (li.rentedQty - li.returnedQty), 0);
      // currentStock is now on-hand availability; total capacity = available + rented-out.
      const capacity = (item.currentStock || 0) + totalRented || 1;
      const percent = Math.min(100, Math.max(0, parseFloat(((totalRented / capacity) * 100).toFixed(1))));
      return {
        name: item.name,
        percent,
        rented: totalRented,
        stock: capacity,
        category: item.category
      };
    });

    if (cat) {
      utilizationChart = utilizationChart.filter(u => u.category.toLowerCase() === cat);
    }

    res.json({
      activeRentalIncome,
      depositsCollected,
      outstandingInvoices,
      assetUtilization: parseFloat(assetUtilization.toFixed(1)),
      utilizationChart
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Invoice Aging Report
app.get('/api/reports/invoice-aging', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const invoices = await prisma.invoice.findMany({
      where: { status: { in: OPEN_INVOICE_STATUSES }, companyId }
    });

    const now = new Date();
    let current = 0;
    let overdue1to30 = 0;
    let overdue31to60 = 0;
    let overdue61to90 = 0;
    let overdue90Plus = 0;

    for (const inv of invoices) {
      const due = new Date(inv.dueDate);
      const diffTime = now.getTime() - due.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      const amount = collectibleBalance(inv);
      if (amount <= 0) continue;

      if (diffDays <= 0) {
        current += amount;
      } else if (diffDays <= 30) {
        overdue1to30 += amount;
      } else if (diffDays <= 60) {
        overdue31to60 += amount;
      } else if (diffDays <= 90) {
        overdue61to90 += amount;
      } else {
        overdue90Plus += amount;
      }
    }

    res.json({
      current: round2(current),
      overdue1to30: round2(overdue1to30),
      overdue31to60: round2(overdue31to60),
      overdue61to90: round2(overdue61to90),
      overdue90Plus: round2(overdue90Plus),
      totalUnpaid: round2(current + overdue1to30 + overdue31to60 + overdue61to90 + overdue90Plus)
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Site-activity report: per-site staff assignments + roster (JSON for display)
app.get('/api/reports/site-activity', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const sites = await prisma.site.findMany({
      where: { companyId },
      include: { siteAssignments: { include: { employee: true } } },
      orderBy: { name: 'asc' },
    });
    const report = sites.map(s => ({
      id: s.id, name: s.name, location: s.location || '', contactPerson: s.contactPerson || '',
      contactInfo: s.contactInfo || '', staffCount: s.siteAssignments.length,
      primaryStaff: s.siteAssignments.filter(a => a.isPrimary).map(a => a.employee.name),
      staff: s.siteAssignments.map(a => ({ name: a.employee.name, role: a.employee.role, isPrimary: a.isPrimary })),
    }));
    res.json({ report, totals: { sites: sites.length, assignments: report.reduce((n, r) => n + r.staffCount, 0) } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Site-activity report as CSV (one row per site→staff assignment)
app.get('/api/export/site-activity', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const sites = await prisma.site.findMany({
      where: { companyId },
      include: { siteAssignments: { include: { employee: true } } },
      orderBy: { name: 'asc' },
    });
    let csv = 'site,location,contactPerson,contactInfo,staffName,staffRole,isPrimary\n';
    sites.forEach(s => {
      if (s.siteAssignments.length === 0) {
        csv += `${csvCell(s.name)},${csvCell(s.location)},${csvCell(s.contactPerson)},${csvCell(s.contactInfo)},,,\n`;
      } else {
        s.siteAssignments.forEach(a => {
          csv += `${csvCell(s.name)},${csvCell(s.location)},${csvCell(s.contactPerson)},${csvCell(s.contactInfo)},${csvCell(a.employee.name)},${csvCell(a.employee.role)},${a.isPrimary}\n`;
        });
      }
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=site-activity-report.csv');
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Earlier builds created 'superadmin' / 'changeme-superadmin' and demo users
// with 'password123'. Flag any active account still using one of those so the
// operator can rotate it (we don't change it automatically: that could lock
// the only administrator out).
async function warnAboutKnownDefaultPasswords() {
  const known = ['changeme-superadmin', 'password123'];
  const users = await prisma.user.findMany({
    where: { isActive: true, username: { in: ['superadmin', 'admin', 'staff', 'kampala_admin'] } },
    select: { username: true, password: true, isSuperuser: true },
  });
  for (const u of users) {
    if (known.some(pw => passwordMatches(pw, u.password))) {
      console.warn(`[Security] Account '${u.username}'${u.isSuperuser ? ' (PLATFORM ADMIN)' : ''} still uses a published default password. Change it or disable the account immediately.`);
    }
  }
}

// Ensures a platform super-admin account exists (idempotent). There is NO
// built-in default: the account is created only from explicit one-time setup
// credentials (PLATFORM_ADMIN_USER + PLATFORM_ADMIN_PASSWORD, min 12 chars).
// An existing account with that username is never promoted — whoever owns it
// would silently gain platform rights — so setup stops on a collision.
// A superuser has NO company/profile: it manages the platform, not a tenant.
async function ensureSuperuser() {
  try {
    await warnAboutKnownDefaultPasswords();
    const existing = await prisma.user.findFirst({ where: { isSuperuser: true } });
    if (existing) return;
    const username = (process.env.PLATFORM_ADMIN_USER || '').trim();
    const password = process.env.PLATFORM_ADMIN_PASSWORD || '';
    if (!username || !password) {
      console.warn('[Platform] No platform administrator exists. To create one, set PLATFORM_ADMIN_USER and PLATFORM_ADMIN_PASSWORD for a single start, then remove them.');
      return;
    }
    if (password.length < 12) {
      console.error('[Platform] PLATFORM_ADMIN_PASSWORD must be at least 12 characters. No platform administrator was created.');
      return;
    }
    const email = (process.env.PLATFORM_ADMIN_EMAIL || '').trim() || `${username}@platform.invalid`;
    const clash = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] } });
    if (clash) {
      console.error(`[Platform] Refusing to create platform administrator: an account with username '${username}' or that email already exists. Choose a different PLATFORM_ADMIN_USER. No account was changed.`);
      return;
    }
    await prisma.user.create({
      data: {
        username, email, password: hashPassword(password),
        firstName: 'Platform', lastName: 'Admin',
        isActive: true, isSuperuser: true, emailVerified: true,
      },
    });
    console.log(`[Platform] Created platform administrator '${username}'. Remove PLATFORM_ADMIN_PASSWORD from the environment now.`);
  } catch (err: any) {
    console.error('[Platform] ensureSuperuser failed:', err.message);
  }
}

// Ensures every company has the built-in Administrator role (full access) and a
// starter Staff role, and back-fills companyRoleId on existing users from their
// coarse Admin/User tier. Idempotent — safe to run on every boot.
async function ensureCompanyRoles() {
  try {
    const companies = await prisma.company.findMany({ select: { id: true } });
    for (const c of companies) {
      let adminRole = await prisma.companyRole.findFirst({ where: { companyId: c.id, isSystemAdmin: true } });
      if (!adminRole) {
        adminRole = await prisma.companyRole.create({
          data: { companyId: c.id, name: 'Administrator', description: 'Full access to everything (built-in).',
            isSystemAdmin: true, permissions: fullAccess() as any },
        });
      }
      let staffRole = await prisma.companyRole.findFirst({ where: { companyId: c.id, name: 'Staff', isSystemAdmin: false } });
      if (!staffRole) {
        staffRole = await prisma.companyRole.create({
          data: { companyId: c.id, name: 'Staff', description: 'Day-to-day operations; no financials, settings, or team management.',
            isSystemAdmin: false, permissions: defaultStaffPermissions() as any },
        });
      }
      // Back-fill role assignment for existing members without one.
      const unassigned = await prisma.userProfile.findMany({ where: { companyId: c.id, companyRoleId: null } });
      for (const p of unassigned) {
        await prisma.userProfile.update({
          where: { id: p.id },
          data: { companyRoleId: p.role === 'Admin' ? adminRole.id : staffRole.id },
        });
      }
    }
    if (companies.length) console.log(`[RBAC] Company roles ensured for ${companies.length} company(ies).`);
  } catch (err: any) {
    console.error('[RBAC] ensureCompanyRoles failed:', err.message);
  }
}

// Boot Lifecycle
async function startServer() {
  try {
    // 1. Ensure MariaDB database exists
    await ensureDatabaseExists();

    // 2. Apply Prisma migrations. Resolve the Prisma CLI directly and run it with
    //    the current node binary — this works in a packaged desktop bundle (where
    //    `npx` doesn't exist) as well as in dev; fall back to `npx` if unresolved.
    console.log("Prisma: Running database migrations...");
    try {
      let prismaCli: string | null = null;
      try { prismaCli = require.resolve('prisma/build/index.js', { paths: [process.cwd(), __dirname, path.join(__dirname, '..')] }); } catch { /* not resolvable */ }
      // Explicit --schema so migrations resolve regardless of CWD (bundled app).
      const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
      const schemaArgs = fs.existsSync(schemaPath) ? ['--schema', schemaPath] : [];
      if (prismaCli) {
        execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', ...schemaArgs], { stdio: 'inherit' });
      } else {
        execSync('npx prisma migrate deploy', { stdio: 'inherit' });
      }
    } catch (e: any) {
      console.error('Prisma migrate deploy failed:', e.message);
      throw e;
    }
    console.log("Migrations applied successfully.");

    // 3. Seed database
    await seedDatabase();

    // 3b. Ensure a platform super-admin account exists (idempotent).
    await ensureSuperuser();

    // 3c. Ensure business roles (Administrator/Staff) exist + back-fill assignments.
    await ensureCompanyRoles();

    // 4. Background overdue scanner — run once on boot, then every 6 hours
    const runOverdueScanner = async () => {
      try {
        const now = new Date();
        const overdueOrders = await prisma.rentalOrder.findMany({
          where: {
            status: 'Active',
            expectedReturnDate: { lt: now },
            actualReturnDate: null
          },
          include: { lineItems: true }
        });

        for (const order of overdueOrders) {
          const daysOverdue = Math.max(0, Math.ceil(
            (now.getTime() - new Date(order.expectedReturnDate).getTime()) / (1000 * 60 * 60 * 24)
          ));
          const lateFee = order.lineItems.reduce((sum: number, li: any) => {
            return sum + (Number(li.dailyRate) * 0.10 * daysOverdue * li.rentedQty);
          }, 0);

          await prisma.rentalOrder.update({
            where: { id: order.id },
            data: {
              status: 'Overdue',
              totalLateFeeCalculated: lateFee,
              lateFeeAppliedAt: now,
              overdueAlertSent: true
            }
          });

          // Only write audit once per order (first time flagged)
          if (!order.overdueAlertSent) {
            await prisma.auditLog.create({
              data: {
                companyId: order.companyId,
                username: 'system',
                action: 'ORDER_MARKED_OVERDUE',
                modelName: 'RentalOrder',
                objectId: order.id,
                objectRepr: order.companyOrderNumber,
                additionalInfo: `Order automatically flagged overdue after ${daysOverdue} day(s). Projected fee: ${Math.round(lateFee).toLocaleString()}.`
              }
            });
            await createNotification({
              companyId: order.companyId, category: 'overdue',
              title: `Overdue: Order #${order.companyOrderNumber}`,
              message: `${order.customerName}'s rental is ${daysOverdue} day(s) overdue. Projected late fee: ${Math.round(lateFee).toLocaleString()}.`,
              link: order.companyOrderNumber, dedupe: true,
            });
          }
        }
        if (overdueOrders.length > 0) {
          console.log(`[Overdue Scanner] Flagged ${overdueOrders.length} overdue rental order(s).`);
        }
      } catch (err: any) {
        console.error('[Overdue Scanner] Error:', err.message);
      }
    };

    // Run immediately on boot, then every 6 hours
    await runOverdueScanner();
    setInterval(runOverdueScanner, 6 * 60 * 60 * 1000);

    // 4b. Automatic database backup — catch up on boot (covers a machine that was
    // off through the scheduled hour), then re-check hourly. See backup.ts.
    await maybeRunScheduledBackup();
    setInterval(maybeRunScheduledBackup, 60 * 60 * 1000);

    // 4c. Desktop licensing — start the trial clock on first run (no-op unless
    // LICENSE_ENFORCED is set, i.e. the packaged desktop build). See license.ts.
    initLicense();

    // 5. Seed Help Guide Center & FAQs
    await seedHelpCenter();

    // 5b. Seed System Health Components
    await seedSystemComponents();

    // 6. Start Express server
    app.listen(PORT, () => {
      console.log(`Server is running successfully on port ${PORT}`);
    });
  } catch (error: any) {
    console.error("Critical error during server boot. Exiting:", error.message);
    process.exit(1);
  }
}

// Help Guide database seeder
async function seedHelpCenter() {
  try {
    const categoryCount = await prisma.helpCategory.count();
    if (categoryCount > 0) return; // already seeded

    console.log('[Seeder] Seeding Help Center guides and FAQs...');

    // 1. Categories
    const billingCat = await prisma.helpCategory.create({
      data: {
        name: 'Billing & Ledgers',
        icon: 'FileText',
        description: 'Invoice processing, payment term settings, client statements, credit limit adjustments, and ledger entries.'
      }
    });

    const dispatchCat = await prisma.helpCategory.create({
      data: {
        name: 'Dispatch Operations',
        icon: 'Truck',
        description: 'Stock check-outs, return operations, serialized fleet assignment, and tracking overdue rentals.'
      }
    });

    const bookingCat = await prisma.helpCategory.create({
      data: {
        name: 'Booking Guides',
        icon: 'CalendarRange',
        description: 'Creating new rental contracts, securing cash deposits, and processing customer order cancellations.'
      }
    });

    const fleetCat = await prisma.helpCategory.create({
      data: {
        name: 'Fleet Maintenance',
        icon: 'Building',
        description: 'Scheduling fleet calibration, recording service logs, writing off damaged tools, and restocking consumables.'
      }
    });

    // 2. Articles
    await prisma.helpArticle.create({
      data: {
        categoryId: billingCat.id,
        title: 'Managing Client Account Statements',
        slug: 'managing-client-statements',
        content: `### Customer ledger & Statements guide
This module explains how to review, manage, and print statement files for customer ledger accounts.

1. **Accessing Ledger Accounts:** Go to the "Customer Ledgers" tab in the left sidebar menu.
2. **Reviewing Transactions:** Click on any client line to view details, credit utilization gauges, and aging buckets (31-60, 61-90, and 90+ days).
3. **Recording Manual Credit/Debit Adjustments:** Click "Post Manual Adjustment", specify transaction type (e.g. discount refund credit), value, and receipt number.
4. **Printing Statements:** Click the print statement icon to view the clean, distraction-free A4 statement format. Press **Ctrl + P** to save as PDF or print.`
      }
    });

    await prisma.helpArticle.create({
      data: {
        categoryId: dispatchCat.id,
        title: 'Handling Overdue Returns & Late Fees',
        slug: 'handling-overdue-returns-fees',
        content: `### Fleet returns & late fee operations guide
Manage active rental returns, mark stock levels back to available, and track overdue items.

1. **Returns Console:** In the "Dispatches & Returns" tab, all active dispatches are visible with red badges if they pass the scheduled return date.
2. **Late Fee Mechanism:** The system applies a daily late fee calculated at **10% of the daily rental rate** multiplied by late days.
3. **Refunding or Adjusting Late Fees:** When returning stock, if the late fee needs waiver, you can post a credit note in the "Credit Notes" tab or use customer ledger offsets.`
      }
    });

    await prisma.helpArticle.create({
      data: {
        categoryId: bookingCat.id,
        title: 'Pre-Event Planning & Equipment Shortages',
        slug: 'pre-event-planning-shortages',
        content: `### Pre-Event logistics scheduling guide
Organize client functions and track equipment availability.

1. **Scheduling events:** Go to "Staff & Scheduling" -> "Event Planner" to add new functions with Client details.
2. **2-Day Availability Scanner:** The dashboard scans booking equipment lines 2 days before the scheduled date.
3. **Shortage Warning Widget:** If items are out on rent, in maintenance, or total bulk inventory is short, a bright red alert warns the team on the dashboard.`
      }
    });

    await prisma.helpArticle.create({
      data: {
        categoryId: fleetCat.id,
        title: 'Tracking Consumables & Calibration Events',
        slug: 'tracking-consumables-calibration',
        content: `### Consumable stock & calibration guide
Manage one-way supplies and track serialized fleet service logs.

1. **Serialized Asset Maintenance:** Select "Items & Assets" -> "Serialized Fleet Assets", select a unit, and click "Maintenance". Logging a servicing event locks the asset status to "Maintenance".
2. **Consumable stock:** Go to the "Consumable Stock" sub-tab to register tape, fuel, paper cups.
3. **Stock Replenishments:** Click "Restock" to log quantity additions, invoice costs, and vendor notes. Keep stock levels above the specified restock threshold.`
      }
    });

    // 3. FAQs
    await prisma.fAQ.createMany({
      data: [
        {
          question: 'How do I print an Account Statement?',
          answer: 'Navigate to the Customer Ledgers tab, search for the client, click "Print Statement" to open the printable layout, then press Ctrl+P or the print button.',
          displayOrder: 1,
          isFeatured: true
        },
        {
          question: 'What happens if consumable stock falls below the restock warning level?',
          answer: 'For consumables, a red warning badge will appear under the Consumable Stock tab to prompt immediate replenishments.',
          displayOrder: 2,
          isFeatured: true
        },
        {
          question: 'How do I assign staff to event roles?',
          answer: 'Go to Staff & Scheduling, find the event, click "Manage Event", select Staff Assignments, choose an employee, and click Assign Role.',
          displayOrder: 3,
          isFeatured: true
        },
        {
          question: 'Are late fees applied automatically?',
          answer: 'Yes! A background worker runs every 6 hours to mark overdue orders and project 10% daily late fees. You can view or adjust them in the returns page.',
          displayOrder: 4,
          isFeatured: true
        }
      ]
    });

    console.log('[Seeder] Help Center seeding complete!');
  } catch (err: any) {
    console.error('Error seeding help center:', err.message);
  }
}

// System health components seeder
async function seedSystemComponents() {
  try {
    const count = await prisma.systemComponent.count();
    if (count > 0) return;

    console.log('[Seeder] Seeding System Health components...');

    await prisma.systemComponent.createMany({
      data: [
        { name: 'API Server', description: 'Express.js REST API backend service handling all business logic endpoints.', status: 'operational' },
        { name: 'Database', description: 'MariaDB/MySQL primary data store powering Prisma ORM queries.', status: 'operational' },
        { name: 'Authentication', description: 'JWT token-based login, session management, and role-based access control.', status: 'operational' },
        { name: 'File Storage', description: 'Local filesystem and static asset serving for uploads and exports.', status: 'operational' },
        { name: 'Email Service', description: 'Outbound transactional email notifications (invoice delivery, password resets).', status: 'operational' },
        { name: 'Background Workers', description: 'Overdue scanner cron, scheduled alerts, and automated fee calculations.', status: 'operational' }
      ]
    });

    console.log('[Seeder] System Health components seeding complete!');
  } catch (err: any) {
    console.error('Error seeding system components:', err.message);
  }
}

// ── MIDWAY SUPPORT DESK ────────────────────────────────────────────────────
// In-app support: users file tickets into the central Midway desk and hold a
// two-way conversation with an agent without leaving YourHires.
//
// Every route here is proxied server-to-server so the channel API key never
// reaches the browser. They all sit behind the global authentication gate (they
// are not on the public allowlist), so a session is guaranteed — and the requester
// identity is taken from that session, never from the request body, so a user
// cannot file a ticket as someone else.
//
// Note: screenshots are not supported yet. The desk accepts multipart uploads, but
// Express has no multipart parser wired up here (no multer dependency) — matching
// the YourBooks POS integration. Text-only tickets otherwise use the full contract.

// Map an upstream MidwaySupportError to a client response, else a generic 500.
function handleSupportError(res: express.Response, err: any) {
  if (err instanceof MidwaySupportError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('[SUPPORT] Unexpected error:', err);
  return res.status(500).json({ error: err?.message || 'Support request failed.' });
}

/** Requester identity for a ticket, resolved from the authoritative session. */
async function resolveSupportRequester(req: express.Request) {
  const sess = await resolveSession(req);
  if (!sess) return null;
  const user = await prisma.user.findUnique({
    where: { id: sess.userId },
    include: { profile: { include: { company: true } } },
  });
  if (!user) return null;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return {
    userId: user.id,
    companyId: user.profile?.companyId ?? null,
    // A username is always present; the real name is nicer for an agent to read.
    requesterName: fullName || user.username,
    requesterEmail: user.email,
    // Users have no phone field — the company's number is the useful callback.
    requesterPhone: user.profile?.company?.phone || undefined,
    companyName: user.profile?.company?.name || undefined,
  };
}

// GET /api/support/status — lets the client hide the support UI when unconfigured.
app.get('/api/support/status', (req: express.Request, res: express.Response) => {
  res.json({ configured: isSupportConfigured(), system: SUPPORT_SYSTEM_NAME });
});

// GET /api/support/kb?q= — self-service knowledge base search, shown before ticketing.
app.get('/api/support/kb', async (req: express.Request, res: express.Response) => {
  try {
    const q = String(req.query.q || '').trim();
    const data = await searchKb(q, SUPPORT_SYSTEM_NAME);
    res.json(data);
  } catch (err) {
    handleSupportError(res, err);
  }
});

// GET /api/support/tickets — this user's filed requests, newest first. Served from
// our local index because the channel API has no list endpoint.
app.get('/api/support/tickets', async (req: express.Request, res: express.Response) => {
  try {
    const requester = await resolveSupportRequester(req);
    if (!requester) return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    let tickets: any[] = [];
    try {
      tickets = await prisma.midwaySupportTicket.findMany({
        where: { userId: requester.userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { ref: true, subject: true, system: true, status: true, priority: true, createdAt: true, updatedAt: true },
      });
    } catch {
      // Table not migrated yet — an empty list beats a 500.
      tickets = [];
    }
    res.json({ tickets });
  } catch (err) {
    handleSupportError(res, err);
  }
});

// POST /api/support/tickets — open a ticket. Requester fields come from the session;
// the client only supplies subject / description / priority.
app.post('/api/support/tickets', async (req: express.Request, res: express.Response) => {
  try {
    const requester = await resolveSupportRequester(req);
    if (!requester) return res.status(401).json({ error: 'Authentication required. Please sign in.' });

    const subject = String(req.body?.subject || '').trim();
    const description = String(req.body?.description || req.body?.message || '').trim();
    const priorityRaw = String(req.body?.priority || 'NORMAL').toUpperCase();
    const priority = (['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(priorityRaw) ? priorityRaw : 'NORMAL') as
      'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

    if (!subject || !description) {
      return res.status(400).json({ error: 'A subject and a description are required.' });
    }
    if (!requester.requesterEmail) {
      return res.status(400).json({ error: 'Your account has no email on file; add one before contacting support.' });
    }

    // Naming the tenant up front saves the agent a round-trip asking "which company?".
    const context = requester.companyName ? `[Company: ${requester.companyName}]\n\n` : '';

    const result = await createTicket({
      requesterName: requester.requesterName,
      requesterEmail: requester.requesterEmail,
      requesterPhone: requester.requesterPhone,
      externalUserId: String(requester.userId),
      system: SUPPORT_SYSTEM_NAME,
      subject,
      description: `${context}${description}`,
      priority,
    });

    const ref = result?.ticketRef || result?.ticket?.ref;
    if (ref) {
      // Index failures must not fail the request — the ticket already exists upstream.
      await prisma.midwaySupportTicket.upsert({
        where: { ref },
        create: {
          ref,
          companyId: requester.companyId,
          userId: requester.userId,
          system: result?.ticket?.system || SUPPORT_SYSTEM_NAME,
          subject,
          status: result?.ticket?.status || 'OPEN',
          priority: result?.ticket?.priority || priority,
        },
        update: { status: result?.ticket?.status || 'OPEN', priority: result?.ticket?.priority || priority },
      }).catch((e: any) => console.error('[SUPPORT] Failed to index ticket ref:', ref, e?.message));
    }

    res.status(201).json({
      success: true,
      ticketRef: ref,
      autoReply: result?.autoReply,
      ticket: result?.ticket,
    });
  } catch (err) {
    handleSupportError(res, err);
  }
});

// Confirm a ref belongs to the caller before we proxy anything about it — otherwise
// any logged-in user could read another tenant's thread by guessing a reference.
async function ownsSupportTicket(userId: number, ref: string): Promise<boolean> {
  try {
    const row = await prisma.midwaySupportTicket.findUnique({ where: { ref } });
    return !!row && row.userId === userId;
  } catch {
    return false;
  }
}

// GET /api/support/tickets/:ref — full thread + status (poll while the screen is open).
app.get('/api/support/tickets/:ref', async (req: express.Request, res: express.Response) => {
  try {
    const requester = await resolveSupportRequester(req);
    if (!requester) return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    const ref = String(req.params.ref);
    if (!(await ownsSupportTicket(requester.userId, ref))) {
      return res.status(404).json({ error: 'Support request not found.' });
    }

    const data = await getTicket(ref);
    // Refresh the cached status so the list reflects agent activity.
    if (data?.status) {
      await prisma.midwaySupportTicket.update({ where: { ref }, data: { status: data.status } }).catch(() => {});
    }
    res.json({
      ...data,
      attachments: (data?.attachments || []).map((a: any) => ({ ...a, url: absoluteAttachmentUrl(a.url) })),
    });
  } catch (err) {
    handleSupportError(res, err);
  }
});

// POST /api/support/tickets/:ref — post a requester reply into the thread (two-way).
app.post('/api/support/tickets/:ref', async (req: express.Request, res: express.Response) => {
  try {
    const requester = await resolveSupportRequester(req);
    if (!requester) return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    const ref = String(req.params.ref);
    if (!(await ownsSupportTicket(requester.userId, ref))) {
      return res.status(404).json({ error: 'Support request not found.' });
    }

    const body = String(req.body?.body || req.body?.message || '').trim();
    if (!body) return res.status(400).json({ error: 'A reply message is required.' });

    const result = await replyToTicket(ref, body, requester.requesterName);
    if (result?.status) {
      await prisma.midwaySupportTicket.update({ where: { ref }, data: { status: result.status } }).catch(() => {});
    }
    res.status(201).json({ success: true, status: result?.status });
  } catch (err) {
    handleSupportError(res, err);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// TAX RATES & URA EFRIS E-INVOICING
// ══════════════════════════════════════════════════════════════════════════
//
// YourHires talks to the Midway EFRIS middleware over HTTPS; the middleware does
// the URA-facing work (signing, the T-interface payloads, FDN and QR issuance).
// Everything here is about deciding WHAT to send and recording what came back.
//
// Two rules from the integration guide shape the flow:
//   • Nothing can be billed to URA before it is registered (T130).
//   • An invoice is never auto-retried (§7.2) — a timed-out submission is
//     recovered by asking for it back, because submitting twice taxes twice.

// ── Shared helpers ─────────────────────────────────────────────────────────

/** Adds the tax breakdown and amount-in-words an invoice needs to be printed. */
function withInvoiceSummary(invoice: any) {
  return {
    ...decorateInvoice(invoice),
    taxSummary: taxSummary((invoice.lineItems || []).map((l: any) => ({
      taxCode: l.taxCode,
      taxRatePercent: Number(l.taxRatePercent),
      lineNet: Number(l.lineNet),
      lineTax: Number(l.lineTax),
    }))).map(r => ({ ...r, label: taxCategoryLabel(r.taxCode) })),
    amountInWords: amountInWords(
      Number(invoice.amount),
      invoice.currency === 'UGX' ? 'Shillings' : (invoice.currency || 'Shillings')
    ),
  };
}

/**
 * The company row plus its resolved EFRIS config. Throws a plain Error with a
 * message meant for the operator, since every caller surfaces it as-is.
 */
async function requireEfris(companyId: number) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error('Company not found.');
  const cfg = resolveEfrisConfig(company);
  if (!cfg) {
    throw new Error(company.efrisEnabled
      ? 'No EFRIS API key has been saved yet. Add it under Settings → URA EFRIS.'
      : 'URA EFRIS is switched off for this business. Turn it on under Settings → URA EFRIS.');
  }
  return { company, cfg };
}

/**
 * The seller as it should appear on a fiscal invoice. URA's own response is
 * preferred over our local record — that is what was actually filed.
 */
function sellerFromResponse(eInvoiceResponse: any, company: any, referenceNumber: string) {
  const fromUra = eInvoiceResponse?.seller ? extractTaxpayer(eInvoiceResponse.seller) : null;
  return {
    tin: fromUra?.tin || company?.efrisTin || '',
    legalName: fromUra?.legalName || company?.name || '',
    tradeName: fromUra?.tradeName || '',
    address: fromUra?.address || company?.address || '',
    referenceNumber: eInvoiceResponse?.seller?.reference_number || referenceNumber,
  };
}

/** The EFRIS unit code for an invoice line, falling back through what's available. */
function lineUnitCode(line: any): string {
  if (line.unitOfMeasure) return unitCode(line.unitOfMeasure);
  if (line.item?.unitOfMeasure) return legacyUnitToEfris(line.item.unitOfMeasure);
  return 'PCE';
}

/** The catalogue entity behind an invoice line, if it has one. */
function lineEntity(line: any): { kind: 'ITEM' | 'ASSET' | 'CONSUMABLE'; entity: any } | null {
  if (line.item) return { kind: 'ITEM', entity: line.item };
  if (line.asset) return { kind: 'ASSET', entity: line.asset };
  if (line.consumable) return { kind: 'CONSUMABLE', entity: line.consumable };
  return null;
}

// ── TAX RATES (Settings) ───────────────────────────────────────────────────

app.get('/api/tax-rates', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.taxRate.findMany({ where: { companyId }, orderBy: { id: 'asc' } });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Seeds the standard Ugandan set (18% / zero-rated / exempt) so a business
 * doesn't have to know URA's category codes to get started.
 */
app.post('/api/tax-rates/defaults', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const existing = await prisma.taxRate.count({ where: { companyId } });
    if (existing > 0) return res.status(400).json({ error: 'This business already has tax rates set up.' });
    await prisma.taxRate.createMany({
      data: DEFAULT_TAX_RATES.map(r => ({ ...r, companyId })),
    });
    const list = await prisma.taxRate.findMany({ where: { companyId }, orderBy: { id: 'asc' } });
    audit(req, 'CREATE', 'TaxRate', null, 'Default rates', `Standard Uganda tax rates added (${list.length}).`);
    res.status(201).json(list);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/tax-rates', async (req, res) => {
  const companyId = getCompanyId(req);
  const { name, rate, taxCode, isDefault } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'A name is required.' });
  const fraction = Number(rate);
  if (isNaN(fraction) || fraction < 0 || fraction > 1) {
    return res.status(400).json({ error: 'The rate must be a fraction between 0 and 1 (0.18 for 18%).' });
  }
  try {
    const created = await prisma.$transaction(async (tx) => {
      // Exactly one rate can be the default, so setting a new one clears the old.
      if (isDefault) await tx.taxRate.updateMany({ where: { companyId }, data: { isDefault: false } });
      return tx.taxRate.create({
        data: {
          companyId,
          name: name.trim(),
          rate: fraction,
          taxCode: (taxCode || '01').trim(),
          isDefault: !!isDefault,
        },
      });
    });
    audit(req, 'CREATE', 'TaxRate', created.id, created.name, `Tax rate created: ${created.name} (${(fraction * 100).toFixed(2)}%).`);
    res.status(201).json(created);
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(400).json({ error: 'A tax rate with that name already exists.' });
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/tax-rates/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { name, rate, taxCode, isDefault, isActive } = req.body;
  try {
    const existing = await prisma.taxRate.findFirst({ where: { id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Tax rate not found.' });

    const data: any = {};
    if (name !== undefined) data.name = String(name).trim();
    if (rate !== undefined) {
      const fraction = Number(rate);
      if (isNaN(fraction) || fraction < 0 || fraction > 1) {
        return res.status(400).json({ error: 'The rate must be a fraction between 0 and 1 (0.18 for 18%).' });
      }
      data.rate = fraction;
    }
    if (taxCode !== undefined) data.taxCode = String(taxCode).trim();
    if (isActive !== undefined) data.isActive = !!isActive;
    if (isDefault !== undefined) data.isDefault = !!isDefault;

    const updated = await prisma.$transaction(async (tx) => {
      if (data.isDefault) await tx.taxRate.updateMany({ where: { companyId }, data: { isDefault: false } });
      return tx.taxRate.update({ where: { id }, data });
    });
    audit(req, 'UPDATE', 'TaxRate', updated.id, updated.name, `Tax rate updated: ${updated.name} (${(Number(updated.rate) * 100).toFixed(2)}%).`);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/tax-rates/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  try {
    const existing = await prisma.taxRate.findFirst({ where: { id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Tax rate not found.' });

    // Invoice lines snapshot their rate, so deleting one never rewrites history —
    // but a rate still in use on the catalogue is retired rather than removed, so
    // items don't silently drop to zero-rated.
    const inUse = await prisma.item.count({ where: { taxRateId: id } })
      + await prisma.serializedAsset.count({ where: { taxRateId: id } })
      + await prisma.consumable.count({ where: { taxRateId: id } });
    if (inUse > 0) {
      const retired = await prisma.taxRate.update({ where: { id }, data: { isActive: false, isDefault: false } });
      audit(req, 'UPDATE', 'TaxRate', id, existing.name, `Tax rate retired (still used by ${inUse} catalogue entr${inUse === 1 ? 'y' : 'ies'}).`);
      return res.json({ retired: true, taxRate: retired, message: `In use by ${inUse} catalogue entr${inUse === 1 ? 'y' : 'ies'}, so it was switched off rather than deleted.` });
    }

    await prisma.taxRate.delete({ where: { id } });
    audit(req, 'DELETE', 'TaxRate', id, existing.name, `Tax rate deleted: ${existing.name}.`);
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── EFRIS SETTINGS ─────────────────────────────────────────────────────────

/**
 * Whether the fiscalize buttons should appear at all. Cheap and unguarded, so
 * every screen can ask without a permission round-trip.
 */
app.get('/api/efris/config', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { efrisEnabled: true, efrisApiKey: true, efrisApiUrl: true, efrisTin: true, efrisFeeRegisteredAt: true },
    });
    const cfg = resolveEfrisConfig(company as any);
    res.json({
      enabled: !!company?.efrisEnabled,
      configured: !!cfg,
      tin: company?.efrisTin || null,
      feeItemRegistered: !!company?.efrisFeeRegisteredAt,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** The admin view of the saved credentials. The key itself is never returned. */
app.get('/api/efris/settings', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found.' });
    res.json({
      enabled: company.efrisEnabled,
      configured: !!company.efrisApiKey?.trim(),
      apiKeyMasked: maskApiKey(company.efrisApiKey),
      apiUrl: company.efrisApiUrl?.trim() || DEFAULT_EFRIS_BASE_URL,
      tin: company.efrisTin || '',
      feeItemCode: company.efrisFeeItemCode,
      feeItemName: company.efrisFeeItemName,
      feeCommodityCode: company.efrisFeeCommodityCode || '',
      feeRegisteredAt: company.efrisFeeRegisteredAt,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/efris/settings', async (req, res) => {
  const companyId = getCompanyId(req);
  const { enabled, apiUrl, apiKey, feeItemCode, feeItemName, feeCommodityCode } = req.body;
  try {
    const data: any = {};
    if (enabled !== undefined) data.efrisEnabled = !!enabled;
    if (apiUrl !== undefined) {
      const url = String(apiUrl).trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'The EFRIS URL must start with http:// or https://' });
      }
      data.efrisApiUrl = url || null;
    }
    // An empty key field means "leave the saved key alone" — the box can never
    // show the stored value, so blanking it must not wipe it.
    if (apiKey !== undefined && String(apiKey).trim()) data.efrisApiKey = String(apiKey).trim();
    // A new key may belong to a different taxpayer, so the cached TIN is dropped
    // and re-read on the next connection test rather than left to go stale.
    if (data.efrisApiKey) data.efrisTin = null;
    if (feeItemCode !== undefined && String(feeItemCode).trim()) data.efrisFeeItemCode = String(feeItemCode).trim();
    if (feeItemName !== undefined && String(feeItemName).trim()) data.efrisFeeItemName = String(feeItemName).trim();
    if (feeCommodityCode !== undefined) data.efrisFeeCommodityCode = String(feeCommodityCode).trim() || null;

    const company = await prisma.company.update({ where: { id: companyId }, data });
    audit(req, 'SETTINGS_UPDATED', 'Company', companyId, company.name,
      `URA EFRIS settings updated — ${company.efrisEnabled ? 'enabled' : 'disabled'}.`);
    res.json({ message: 'EFRIS settings saved.' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Proves the credentials actually work, before a sale depends on them. Uses the
 * excise-duty lookup because it is read-only and cheap.
 */
app.post('/api/efris/test', async (req, res) => {
  const companyId = getCompanyId(req);
  const started = Date.now();
  try {
    const { cfg } = await requireEfris(companyId);
    // /registration-details both proves the key works and returns the taxpayer
    // this key belongs to, which is where the seller TIN on a fiscal invoice
    // comes from — nobody has to type it.
    const details = await efrisRequest(cfg, '/registration-details', { timeoutMs: 30000 });
    const taxpayer = extractTaxpayer(details);

    if (taxpayer.tin) {
      await prisma.company.update({ where: { id: companyId }, data: { efrisTin: taxpayer.tin } });
    }

    res.json({
      message: taxpayer.legalName
        ? `Connected to EFRIS as ${taxpayer.legalName}${taxpayer.tin ? ` (TIN ${taxpayer.tin})` : ''}.`
        : 'Connected to EFRIS successfully.',
      responseMs: Date.now() - started,
      taxpayer,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── EFRIS LOOKUPS ──────────────────────────────────────────────────────────

/** The locally cached excise registry — served without touching the network. */
app.get('/api/efris/excise-codes', async (req, res) => {
  const search = String(req.query.search || '').trim();
  try {
    const codes = await prisma.efrisExciseCode.findMany({
      where: search ? { OR: [{ code: { contains: search } }, { name: { contains: search } }] } : undefined,
      orderBy: { code: 'asc' },
      take: 500,
    });
    res.json(codes);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Refreshes the cached excise registry from URA. */
app.post('/api/efris/sync-excise-codes', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const { cfg } = await requireEfris(companyId);
    const result = await efrisRequest(cfg, '/excise-duty');
    const rows: any[] = result?.excise_codes || result?.exciseCodes || [];
    if (!Array.isArray(rows)) {
      return res.status(502).json({ error: 'Unexpected response shape from the EFRIS excise-duty lookup.' });
    }

    let saved = 0;
    for (const row of rows) {
      const code = String(row.code ?? '').trim();
      if (!code) continue;
      await prisma.efrisExciseCode.upsert({
        where: { code },
        update: {
          name: String(row.name ?? code),
          rate: row.rate != null ? String(row.rate) : null,
          unit: row.unit != null ? String(row.unit) : null,
          currency: row.currency != null ? String(row.currency) : null,
          exciseRule: row.excise_rule != null ? String(row.excise_rule) : (row.exciseRule != null ? String(row.exciseRule) : null),
        },
        create: {
          code,
          name: String(row.name ?? code),
          rate: row.rate != null ? String(row.rate) : null,
          unit: row.unit != null ? String(row.unit) : null,
          currency: row.currency != null ? String(row.currency) : null,
          exciseRule: row.excise_rule != null ? String(row.excise_rule) : (row.exciseRule != null ? String(row.exciseRule) : null),
        },
      });
      saved++;
    }
    audit(req, 'SYNC', 'EfrisExciseCode', null, 'Excise registry', `Synced ${saved} excise duty code(s) from URA.`);
    res.json({ success: true, message: `Synced ${saved} excise duty code(s).`, count: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** Commodity classification codes, for picking a product's commodity code. */
app.get('/api/efris/commodity-categories', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const { cfg } = await requireEfris(companyId);
    const search = String(req.query.search || '').trim();
    const result = await efrisRequest(cfg, `/commodity-categories${search ? `?search=${encodeURIComponent(search)}` : ''}`);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** URA's unit-of-measure list, for reconciling the local catalogue against it. */
app.get('/api/efris/units-of-measure', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const { cfg } = await requireEfris(companyId);
    res.json(await efrisRequest(cfg, '/units-of-measure'));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** Looks up a buyer's TIN to confirm their legal name before a B2B invoice. */
app.get('/api/efris/taxpayer/:tin', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const { cfg } = await requireEfris(companyId);
    res.json(await efrisRequest(cfg, `/taxpayer/${encodeURIComponent(req.params.tin)}`));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** What this business is registered as at URA — TIN, branches, device details. */
app.get('/api/efris/registration-details', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const { cfg } = await requireEfris(companyId);
    res.json(await efrisRequest(cfg, '/registration-details'));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── T130 — PRODUCT REGISTRATION ────────────────────────────────────────────

const EFRIS_KINDS = {
  item: { model: 'item' as const, kind: 'ITEM' as const, label: 'Item', isService: true },
  asset: { model: 'serializedAsset' as const, kind: 'ASSET' as const, label: 'Serialized asset', isService: true },
  consumable: { model: 'consumable' as const, kind: 'CONSUMABLE' as const, label: 'Consumable', isService: false },
};

/**
 * Registers (or updates) one catalogue entry with URA.
 *
 * Hire is a service, so items and assets go up with `is_service: true` and carry
 * no stock at URA. Consumables are sold outright and register as goods, which is
 * what makes their T131 stock movements meaningful.
 */
app.post('/api/efris/register/:kind/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const kindKey = String(req.params.kind) as keyof typeof EFRIS_KINDS;
  const spec = EFRIS_KINDS[kindKey];
  if (!spec) return res.status(400).json({ error: 'Unknown catalogue type. Expected item, asset or consumable.' });
  const id = parseInt(req.params.id);

  try {
    const { cfg } = await requireEfris(companyId);

    const entity: any = await (prisma as any)[spec.model].findFirst({
      where: { id, companyId },
      include: { unitOfMeasureRef: true, taxRate: true },
    });
    if (!entity) return res.status(404).json({ error: `${spec.label} not found.` });

    if (!entity.commodityCode?.trim()) {
      return res.status(400).json({
        error: `${spec.label} "${entity.name}" needs a URA commodity code before it can be registered. Look one up under Commodity Categories.`,
      });
    }

    // Excise duty details come from the cached registry, because URA needs the
    // rule and unit to agree with the code (guide §2).
    let excise: any = null;
    if (entity.haveExciseTax === '101' && entity.exciseDutyCode) {
      excise = await prisma.efrisExciseCode.findUnique({ where: { code: entity.exciseDutyCode } });
      if (!excise) {
        return res.status(400).json({ error: `Excise code ${entity.exciseDutyCode} isn't in the local registry. Sync excise codes first.` });
      }
    }

    // EFRIS wants the gross selling price. Rentals are priced per day, so the
    // registered price is the daily rate — the invoice reports the actual value.
    const netPrice = kindKey === 'consumable'
      ? Number(entity.unitPrice)
      : Number(entity.dailyRentalRate);
    const taxFraction = Number(entity.taxRate?.rate) || 0;
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { pricesIncludeTax: true } });
    const grossPrice = company?.pricesIncludeTax ? netPrice : netPrice * (1 + taxFraction);

    const itemCode = catalogItemCode(spec.kind, entity);
    const payload = buildRegisterProductPayload({
      itemCode,
      itemName: entity.name,
      unitPrice: grossPrice,
      commodityCode: entity.commodityCode.trim(),
      unitOfMeasure: entity.unitOfMeasureRef
        ? unitCode(entity.unitOfMeasureRef)
        : legacyUnitToEfris(entity.unitOfMeasure),
      isService: spec.isService,
      alreadyRegistered: !!entity.efrisRegisteredAt,
      haveExciseTax: entity.haveExciseTax,
      exciseDutyCode: entity.exciseDutyCode,
      exciseRule: excise?.exciseRule ?? null,
      exciseUnit: excise?.unit ?? null,
    });

    const result = await efrisRequest(cfg, '/register-product', { method: 'POST', body: payload });

    const updated = await (prisma as any)[spec.model].update({
      where: { id },
      data: {
        efrisItemCode: itemCode,
        efrisProductCode: result?.commodityGoodsId || result?.goods_id || itemCode,
        efrisRegisteredAt: new Date(),
      },
    });

    audit(req, 'EFRIS_REGISTER', spec.label.replace(/\s/g, ''), id, entity.name,
      `${spec.label} "${entity.name}" ${payload.operationType === '101' ? 'registered with' : 'updated at'} URA EFRIS as ${itemCode}.`);

    res.json({
      success: true,
      message: `"${entity.name}" ${payload.operationType === '101' ? 'registered' : 'updated'} with URA EFRIS.`,
      efrisItemCode: updated.efrisItemCode,
      efrisProductCode: updated.efrisProductCode,
      efrisRegisteredAt: updated.efrisRegisteredAt,
    });
  } catch (err: any) {
    const status = err instanceof EfrisError ? 422 : 400;
    res.status(status).json({ error: err.message, response: err instanceof EfrisError ? err.response : undefined });
  }
});

/**
 * Registers the stand-in service product that late fees, damage recovery and
 * ad-hoc charges are billed under. Without it those lines have no registered
 * item_code and URA rejects the invoice.
 */
app.post('/api/efris/register/fee-item', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const { company, cfg } = await requireEfris(companyId);
    if (!company.efrisFeeCommodityCode?.trim()) {
      return res.status(400).json({ error: 'Set a commodity code for service charges under Settings → URA EFRIS first.' });
    }

    const payload = buildRegisterProductPayload({
      itemCode: company.efrisFeeItemCode,
      itemName: company.efrisFeeItemName,
      // A charge has no fixed price; URA only needs a placeholder here because
      // the invoice line carries the real amount.
      unitPrice: 1,
      commodityCode: company.efrisFeeCommodityCode.trim(),
      unitOfMeasure: 'PCE',
      isService: true,
      alreadyRegistered: !!company.efrisFeeRegisteredAt,
    });

    await efrisRequest(cfg, '/register-product', { method: 'POST', body: payload });
    await prisma.company.update({ where: { id: companyId }, data: { efrisFeeRegisteredAt: new Date() } });

    audit(req, 'EFRIS_REGISTER', 'Company', companyId, company.efrisFeeItemCode,
      `Service-charge product "${company.efrisFeeItemName}" registered with URA EFRIS.`);
    res.json({ success: true, message: `"${company.efrisFeeItemName}" registered with URA EFRIS.` });
  } catch (err: any) {
    const status = err instanceof EfrisError ? 422 : 400;
    res.status(status).json({ error: err.message, response: err instanceof EfrisError ? err.response : undefined });
  }
});

/** Everything in the catalogue that still needs registering, for the EFRIS panel. */
app.get('/api/efris/catalog-status', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const [items, assets, consumables, company] = await Promise.all([
      prisma.item.findMany({
        where: { companyId },
        select: { id: true, name: true, sku: true, commodityCode: true, taxRateId: true, unitOfMeasureId: true, efrisRegisteredAt: true, efrisItemCode: true, haveExciseTax: true, exciseDutyCode: true },
        orderBy: { name: 'asc' },
      }),
      prisma.serializedAsset.findMany({
        where: { companyId },
        select: { id: true, name: true, sku: true, serialNumber: true, commodityCode: true, taxRateId: true, unitOfMeasureId: true, efrisRegisteredAt: true, efrisItemCode: true, haveExciseTax: true, exciseDutyCode: true },
        orderBy: { name: 'asc' },
      }),
      prisma.consumable.findMany({
        where: { companyId },
        select: { id: true, name: true, sku: true, commodityCode: true, taxRateId: true, unitOfMeasureId: true, efrisRegisteredAt: true, efrisItemCode: true, haveExciseTax: true, exciseDutyCode: true },
        orderBy: { name: 'asc' },
      }),
      prisma.company.findUnique({
        where: { id: companyId },
        select: { efrisFeeItemCode: true, efrisFeeItemName: true, efrisFeeCommodityCode: true, efrisFeeRegisteredAt: true },
      }),
    ]);

    const decorate = (rows: any[], kind: string) => rows.map(r => ({
      ...r,
      kind,
      registered: !!r.efrisRegisteredAt,
      // What still has to be filled in before URA will accept it.
      missing: [
        !r.commodityCode?.trim() ? 'commodity code' : null,
        r.haveExciseTax === '101' && !r.exciseDutyCode ? 'excise duty code' : null,
      ].filter(Boolean),
    }));

    res.json({
      items: decorate(items, 'item'),
      assets: decorate(assets, 'asset'),
      consumables: decorate(consumables, 'consumable'),
      feeItem: company,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── T109 — INVOICE FISCALIZATION ───────────────────────────────────────────

/**
 * Fiscalizes an invoice with URA and stores the FDN, verification code, QR and
 * the full response.
 *
 * Idempotent: an invoice that already carries an FDN is returned as-is rather
 * than re-submitted, because a duplicate submission is a duplicate tax charge
 * that can only be undone with a credit note.
 */
async function fiscalizeInvoice(companyId: number, invoiceId: number, operator: string) {
  const { company, cfg } = await requireEfris(companyId);

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId },
    include: INVOICE_INCLUDE,
  });
  if (!invoice) throw new Error('Invoice not found.');

  if (invoice.efrisFDN) {
    return {
      status: 'ACCEPTED' as const,
      fdn: invoice.efrisFDN,
      verificationCode: invoice.efrisVerificationCode || '',
      qrCode: invoice.efrisQRCode || '',
      invoiceNo: invoice.efrisInvoiceNo || '',
      eInvoiceResponse: invoice.eInvoiceResponse,
      alreadyFiscalized: true,
    };
  }
  if (invoice.lineItems.length === 0) {
    throw new Error('This invoice has no line items, so there is nothing to report to URA.');
  }
  if (invoice.status === 'Credited') {
    throw new Error('This invoice has been fully credited and can no longer be fiscalized.');
  }

  // Nothing may be billed to URA under a code it doesn't know (guide §7.1).
  const unregistered: string[] = [];
  let usesFeeLines = false;
  for (const line of invoice.lineItems as any[]) {
    const found = lineEntity(line);
    if (!found) { usesFeeLines = true; continue; }
    if (!found.entity.efrisRegisteredAt) unregistered.push(found.entity.name);
  }
  if (unregistered.length) {
    const list = [...new Set(unregistered)].join(', ');
    throw new Error(`These are not registered with URA yet: ${list}. Register them under Settings → URA EFRIS before fiscalizing.`);
  }
  if (usesFeeLines && !company.efrisFeeRegisteredAt) {
    throw new Error('This invoice has charge lines. Register the service-charge product under Settings → URA EFRIS first.');
  }

  // Excise details for any line whose product carries duty.
  const exciseCodes = [...new Set((invoice.lineItems as any[])
    .map(l => lineEntity(l)?.entity)
    .filter(e => e?.haveExciseTax === '101' && e?.exciseDutyCode)
    .map(e => e.exciseDutyCode as string))];
  const exciseMap = new Map<string, any>();
  if (exciseCodes.length) {
    const rows = await prisma.efrisExciseCode.findMany({ where: { code: { in: exciseCodes } } });
    for (const row of rows) exciseMap.set(row.code, row);
  }

  const items = (invoice.lineItems as any[]).map((line) => {
    const found = lineEntity(line);
    const entity = found?.entity;
    const excise = entity?.haveExciseTax === '101' && entity?.exciseDutyCode
      ? exciseMap.get(entity.exciseDutyCode) || null
      : null;

    return {
      itemName: line.description,
      itemCode: entity
        ? (entity.efrisItemCode || catalogItemCode(found!.kind, entity))
        : company.efrisFeeItemCode,
      commodityCode: entity?.commodityCode || company.efrisFeeCommodityCode || '',
      // A rental line covers several days, and EFRIS has no notion of a rental
      // period — so the days fold into the quantity and the unit price stays the
      // per-day rate. Quantity x price then reproduces the line value exactly.
      quantity: Number(line.quantity) * Math.max(1, line.rentalDays || 1),
      unitPriceNet: Number(line.unitPrice),
      taxRateFraction: Number(line.taxRatePercent),
      taxCode: line.taxCode,
      unitOfMeasure: entity ? lineUnitCode(line) : 'PCE',
      discountNet: Number(line.discount) || 0,
      excise: excise ? {
        code: excise.code, name: excise.name, rate: excise.rate,
        unit: excise.unit, currency: excise.currency, exciseRule: excise.exciseRule,
      } : null,
    };
  });

  const invoiceNo = fiscalReference(invoice.referenceNumber);
  const payload = buildInvoicePayload({
    invoiceNumber: invoiceNo,
    invoiceDate: new Date(invoice.issueDate).toISOString().slice(0, 10),
    customerName: invoice.customerName,
    customerTin: invoice.customerTin,
    paymentMethod: invoice.paymentMethod,
    currency: invoice.currency,
    operator,
    remarks: invoice.notes || invoice.description,
    items,
  });

  let result: any;
  try {
    result = await efrisRequest(cfg, '/submit-invoice', { method: 'POST', body: payload });
  } catch (err: any) {
    // A submission that failed may still have landed. Ask URA for the reference
    // before treating it as failed — never resubmit (guide §7.2).
    const recovered = await efrisRequest(cfg, `/invoice/${encodeURIComponent(invoiceNo)}`).catch(() => null);
    if (recovered && (recovered.fdn || recovered.fiscal_data?.fdn)) {
      result = recovered;
    } else {
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          efrisStatus: 'FAILED',
          efrisError: String(err?.message || err).slice(0, 1000),
          efrisInvoiceNo: invoiceNo,
          ...(err instanceof EfrisError && err.response ? { eInvoiceResponse: err.response as any } : {}),
        },
      });
      throw err;
    }
  }

  const summary = summarizeFiscalResponse(result, invoiceNo);
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      efrisInvoiceNo: invoiceNo,
      efrisFDN: summary.fdn || null,
      efrisVerificationCode: summary.verificationCode || null,
      efrisQRCode: summary.qrCode || null,
      efrisStatus: 'ACCEPTED',
      efrisError: null,
      efrisFiscalizedAt: new Date(),
      eInvoiceResponse: result as any,
    },
  });

  await logAudit(companyId, operator, 'EFRIS_FISCALIZE', 'Invoice', invoice.id, invoice.referenceNumber,
    `Invoice ${invoice.referenceNumber} fiscalized with URA — FDN ${summary.fdn}.`);

  return { status: 'ACCEPTED' as const, ...summary, eInvoiceResponse: result, alreadyFiscalized: false };
}

app.post('/api/invoices/:id/fiscalize', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const efris = await fiscalizeInvoice(companyId, parseInt(req.params.id), getActor(req));
    res.json({ success: true, efris });
  } catch (err: any) {
    res.status(err instanceof EfrisError ? 422 : 400).json({
      success: false,
      error: err.message,
      eInvoiceResponse: err instanceof EfrisError ? err.response : null,
    });
  }
});

/**
 * The stored fiscal response, for re-opening an already-fiscalized invoice
 * without another call to URA (guide §10).
 */
app.get('/api/invoices/:id/fiscal', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: parseInt(req.params.id), companyId },
      include: INVOICE_INCLUDE,
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    const company = await prisma.company.findUnique({ where: { id: companyId } });

    res.json({
      ...withInvoiceSummary(invoice),
      seller: sellerFromResponse(invoice.eInvoiceResponse, company, invoice.referenceNumber),
      eInvoiceResponse: invoice.eInvoiceResponse,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── T110 — CREDIT NOTES ────────────────────────────────────────────────────

/**
 * Fiscalizes a credit note against the invoice it reverses. Only meaningful
 * when that invoice was itself fiscalized — URA has nothing to credit otherwise.
 */
async function fiscalizeCreditNote(companyId: number, creditNoteId: number, operator: string) {
  const { cfg } = await requireEfris(companyId);

  const note = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, companyId },
    include: { lineItems: true, invoice: true },
  });
  if (!note) throw new Error('Credit note not found.');

  if (note.efrisFDN) {
    return {
      status: 'ACCEPTED' as const,
      fdn: note.efrisFDN,
      verificationCode: note.efrisVerificationCode || '',
      qrCode: note.efrisQRCode || '',
      invoiceNo: note.efrisInvoiceNo || '',
      eInvoiceResponse: note.eInvoiceResponse,
      alreadyFiscalized: true,
    };
  }
  if (!note.invoice?.efrisFDN || !note.invoice?.efrisInvoiceNo) {
    throw new Error('The original invoice was never fiscalized with URA, so a credit note does not apply.');
  }
  if (note.lineItems.length === 0) {
    throw new Error('This credit note has no lines, so there is nothing to report to URA.');
  }

  const invoiceLines = await prisma.invoiceLineItem.findMany({
    where: { invoiceId: note.invoiceId! },
    include: { item: true, asset: true, consumable: true },
  });
  const company = await prisma.company.findUnique({ where: { id: companyId } });

  const payload = buildCreditNotePayload({
    originalInvoiceNumber: note.invoice.efrisInvoiceNo,
    originalFdn: note.invoice.efrisFDN,
    reason: note.reason,
    reasonCode: note.reasonCode,
    items: note.lineItems.map((line) => {
      // Match back to the invoice line so the credit carries the same item_code
      // URA saw on the original.
      const source = invoiceLines.find(il =>
        il.description === line.description &&
        il.itemId === line.itemId && il.assetId === line.assetId && il.consumableId === line.consumableId
      ) as any;
      const found = source ? lineEntity(source) : null;
      return {
        itemName: line.description,
        itemCode: found?.entity?.efrisItemCode
          || (found ? catalogItemCode(found.kind, found.entity) : company?.efrisFeeItemCode || 'SERVICE-CHARGE'),
        quantity: Number(line.quantity),
        unitPriceNet: Number(line.unitPrice),
        taxRateFraction: Number(line.taxRatePercent),
        taxCode: line.taxCode,
      };
    }),
  });

  let result: any;
  try {
    result = await efrisRequest(cfg, '/submit-credit-note', { method: 'POST', body: payload });
  } catch (err: any) {
    await prisma.creditNote.update({
      where: { id: note.id },
      data: {
        efrisStatus: 'FAILED',
        efrisError: String(err?.message || err).slice(0, 1000),
        efrisInvoiceNo: note.referenceNumber,
        ...(err instanceof EfrisError && err.response ? { eInvoiceResponse: err.response as any } : {}),
      },
    });
    throw err;
  }

  const summary = summarizeFiscalResponse(result, note.referenceNumber);
  await prisma.creditNote.update({
    where: { id: note.id },
    data: {
      efrisInvoiceNo: note.referenceNumber,
      efrisFDN: summary.fdn || null,
      efrisVerificationCode: summary.verificationCode || null,
      efrisQRCode: summary.qrCode || null,
      efrisStatus: 'ACCEPTED',
      efrisError: null,
      efrisFiscalizedAt: new Date(),
      eInvoiceResponse: result as any,
    },
  });

  await logAudit(companyId, operator, 'EFRIS_CREDIT_NOTE', 'CreditNote', note.id, note.referenceNumber,
    `Credit note ${note.referenceNumber} fiscalized with URA — FDN ${summary.fdn}.`);

  return { status: 'ACCEPTED' as const, ...summary, eInvoiceResponse: result, alreadyFiscalized: false };
}

app.post('/api/credit-notes/:id/fiscalize', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const efris = await fiscalizeCreditNote(companyId, parseInt(req.params.id), getActor(req));
    res.json({ success: true, efris });
  } catch (err: any) {
    res.status(err instanceof EfrisError ? 422 : 400).json({
      success: false,
      error: err.message,
      eInvoiceResponse: err instanceof EfrisError ? err.response : null,
    });
  }
});

// ── T131 — STOCK MOVEMENTS ─────────────────────────────────────────────────
//
// Only consumables carry stock at URA. Hire items and assets are registered as
// services, so they have no stock position to move — they go out and come back
// without ever being sold.

/** Resolves the consumables a stock movement refers to, refusing unregistered ones. */
async function resolveStockItems(companyId: number, rows: any[]) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('At least one consumable is required.');

  const ids = rows.map(r => parseInt(r.consumableId)).filter(n => !isNaN(n));
  const consumables = await prisma.consumable.findMany({
    where: { id: { in: ids }, companyId },
    include: { unitOfMeasure: true },
  });

  const unregistered = consumables.filter(c => !c.efrisRegisteredAt).map(c => c.name);
  if (unregistered.length) {
    throw new Error(`Not registered with URA yet: ${unregistered.join(', ')}. Register them before reporting stock.`);
  }

  return rows.map((row) => {
    const consumable = consumables.find(c => c.id === parseInt(row.consumableId));
    if (!consumable) throw new Error(`Consumable ${row.consumableId} not found.`);
    const quantity = Number(row.quantity);
    if (!(quantity > 0)) throw new Error(`Quantity for "${consumable.name}" must be greater than zero.`);
    return {
      goodsCode: consumable.efrisItemCode || catalogItemCode('CONSUMABLE', consumable),
      quantity,
      unitPrice: row.unitPrice !== undefined ? Number(row.unitPrice) : Number(consumable.unitPrice),
      measureUnit: consumable.unitOfMeasure ? unitCode(consumable.unitOfMeasure) : 'PCE',
    };
  });
}

/** Records the outcome of a stock report, keyed so the same movement can't be sent twice. */
async function recordStockMovement(companyId: number, data: any) {
  return prisma.efrisStockMovement.upsert({
    where: { companyId_reference: { companyId, reference: data.reference } },
    update: data,
    create: { companyId, ...data },
  });
}

/** Reports goods received into stock (T131 increase). */
app.post('/api/efris/stock-increase', async (req, res) => {
  const companyId = getCompanyId(req);
  const { stockInType, supplierName, supplierTin, stockInDate, productionBatchNo, productionDate, items, reference } = req.body;
  try {
    const { cfg } = await requireEfris(companyId);

    const type = String(stockInType || '102');
    if (!STOCK_IN_TYPES[type]) return res.status(400).json({ error: 'Unknown stock-in type.' });
    // URA's own rules, checked here so the operator gets a plain message rather
    // than a numbered rejection from the middleware.
    if (type === '103' && !productionBatchNo?.trim()) {
      return res.status(400).json({ error: 'Manufactured stock needs a production batch number.' });
    }
    if (type !== '103' && !supplierName?.trim()) {
      return res.status(400).json({ error: 'A supplier name is required for this stock-in type.' });
    }

    const resolved = await resolveStockItems(companyId, items);
    const ref = String(reference || `STOCKIN-${Date.now()}`).slice(0, 120);

    const existing = await prisma.efrisStockMovement.findUnique({
      where: { companyId_reference: { companyId, reference: ref } },
    });
    if (existing?.status === 'ACCEPTED') {
      return res.status(400).json({ error: 'This stock movement has already been reported to URA.' });
    }

    const payload = buildStockIncreasePayload({
      stockInType: type,
      supplierName,
      supplierTin,
      stockInDate: (stockInDate || new Date().toISOString().slice(0, 10)).slice(0, 10),
      productionBatchNo,
      productionDate,
      items: resolved,
    });

    try {
      const result = await efrisRequest(cfg, '/stock-increase', { method: 'POST', body: payload });
      await recordStockMovement(companyId, {
        direction: 'INCREASE', reference: ref, stockInType: type,
        supplierName: supplierName || null, supplierTin: supplierTin || null,
        payload, response: result, status: 'ACCEPTED', error: null,
      });
      audit(req, 'EFRIS_STOCK_IN', 'Consumable', null, ref,
        `Reported ${resolved.length} consumable(s) into URA stock (${STOCK_IN_TYPES[type]}).`);
      res.json({ success: true, message: `Stock reported to URA (${STOCK_IN_TYPES[type]}).`, response: result });
    } catch (err: any) {
      await recordStockMovement(companyId, {
        direction: 'INCREASE', reference: ref, stockInType: type,
        supplierName: supplierName || null, supplierTin: supplierTin || null,
        payload, response: err instanceof EfrisError ? err.response : null,
        status: 'FAILED', error: String(err.message).slice(0, 1000),
      });
      throw err;
    }
  } catch (err: any) {
    res.status(err instanceof EfrisError ? 422 : 400).json({ error: err.message });
  }
});

/** Reports stock written off (T131 decrease) — expiry, damage, personal use. */
app.post('/api/efris/stock-decrease', async (req, res) => {
  const companyId = getCompanyId(req);
  const { adjustType, remarks, items, reference } = req.body;
  try {
    const { cfg } = await requireEfris(companyId);

    const type = String(adjustType || '104');
    if (!STOCK_ADJUST_TYPES[type]) return res.status(400).json({ error: 'Unknown adjustment type.' });
    if (type === '104' && !remarks?.trim()) {
      return res.status(400).json({ error: 'URA requires a remark when the adjustment reason is "Others".' });
    }

    const resolved = await resolveStockItems(companyId, items);
    const ref = String(reference || `STOCKOUT-${Date.now()}`).slice(0, 120);

    const existing = await prisma.efrisStockMovement.findUnique({
      where: { companyId_reference: { companyId, reference: ref } },
    });
    if (existing?.status === 'ACCEPTED') {
      return res.status(400).json({ error: 'This stock movement has already been reported to URA.' });
    }

    const payload = buildStockDecreasePayload({ adjustType: type, remarks, items: resolved });

    try {
      const result = await efrisRequest(cfg, '/stock-decrease', { method: 'POST', body: payload });
      await recordStockMovement(companyId, {
        direction: 'DECREASE', reference: ref, adjustType: type,
        remarks: remarks || null, payload, response: result, status: 'ACCEPTED', error: null,
      });
      audit(req, 'EFRIS_STOCK_OUT', 'Consumable', null, ref,
        `Reported ${resolved.length} consumable(s) out of URA stock (${STOCK_ADJUST_TYPES[type]}).`);
      res.json({ success: true, message: `Stock adjustment reported to URA (${STOCK_ADJUST_TYPES[type]}).`, response: result });
    } catch (err: any) {
      await recordStockMovement(companyId, {
        direction: 'DECREASE', reference: ref, adjustType: type,
        remarks: remarks || null, payload,
        response: err instanceof EfrisError ? err.response : null,
        status: 'FAILED', error: String(err.message).slice(0, 1000),
      });
      throw err;
    }
  } catch (err: any) {
    res.status(err instanceof EfrisError ? 422 : 400).json({ error: err.message });
  }
});

/** The stock movements already reported, so failures can be found and retried. */
app.get('/api/efris/stock-movements', async (req, res) => {
  const companyId = getCompanyId(req);
  try {
    const list = await prisma.efrisStockMovement.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json(list.map(m => ({
      ...m,
      typeLabel: m.direction === 'INCREASE'
        ? STOCK_IN_TYPES[m.stockInType || ''] || 'Stock in'
        : STOCK_ADJUST_TYPES[m.adjustType || ''] || 'Adjustment',
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── MANUAL INVOICES ────────────────────────────────────────────────────────

/**
 * Raises an invoice by hand, with real lines. Lines may point at the catalogue
 * (so they fiscalize under a registered product) or be free-text charges billed
 * under the service-charge product.
 */
app.post('/api/invoices', async (req, res) => {
  const companyId = getCompanyId(req);
  const { customerId, customerName, description, dueDate, notes, terms, lines, referenceNumber } = req.body;

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'An invoice needs at least one line.' });
  }
  try {
    const ctx = await loadTaxContext(prisma, companyId);

    const customer = customerId
      ? await prisma.customer.findFirst({ where: { id: parseInt(customerId), companyId } })
      : (customerName?.trim() ? await resolveCustomerByName(customerName.trim(), companyId) : null);
    if (!customer) return res.status(400).json({ error: 'A customer is required.' });

    const drafts: DraftLine[] = [];
    for (const [i, raw] of lines.entries()) {
      const quantity = Number(raw.quantity);
      const enteredPrice = Number(raw.unitPrice);
      if (!(quantity > 0)) return res.status(400).json({ error: `Line ${i + 1}: quantity must be greater than zero.` });
      if (isNaN(enteredPrice) || enteredPrice < 0) return res.status(400).json({ error: `Line ${i + 1}: a unit price is required.` });

      // A line pointing at the catalogue inherits that entry's tax rate; a
      // free-text charge falls back to the company default.
      let entityTaxRateId: number | null = raw.taxRateId ? parseInt(raw.taxRateId) : null;
      let description = String(raw.description || '').trim();
      let unitOfMeasureId = raw.unitOfMeasureId ? parseInt(raw.unitOfMeasureId) : null;
      const itemId = raw.itemId ? parseInt(raw.itemId) : null;
      const assetId = raw.assetId ? parseInt(raw.assetId) : null;
      const consumableId = raw.consumableId ? parseInt(raw.consumableId) : null;

      if (!entityTaxRateId || !description) {
        const source = itemId
          ? await prisma.item.findFirst({ where: { id: itemId, companyId } })
          : assetId
            ? await prisma.serializedAsset.findFirst({ where: { id: assetId, companyId } })
            : consumableId
              ? await prisma.consumable.findFirst({ where: { id: consumableId, companyId } })
              : null;
        if (source) {
          entityTaxRateId = entityTaxRateId ?? source.taxRateId;
          description = description || source.name;
          unitOfMeasureId = unitOfMeasureId ?? (source as any).unitOfMeasureId ?? null;
        }
      }
      if (!description) return res.status(400).json({ error: `Line ${i + 1}: a description is required.` });

      const { tax, unitPrice, grossUnitPrice } = priced(ctx, enteredPrice, entityTaxRateId);
      drafts.push({
        itemType: itemId ? 'item' : assetId ? 'asset' : consumableId ? 'consumable' : 'fee',
        itemId, assetId, consumableId, unitOfMeasureId,
        description,
        quantity,
        rentalDays: Math.max(1, parseInt(raw.rentalDays) || 1),
        unitPrice,
        grossUnitPrice,
        discount: Number(raw.discount) || 0,
        tax,
        sortOrder: i,
      });
    }

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { defaultPaymentTermsDays: true } });
    const due = dueDate ? new Date(dueDate) : new Date(Date.now() + (company?.defaultPaymentTermsDays ?? 30) * 86400000);
    const ref = String(referenceNumber || '').trim() || `INV-${Date.now().toString(36).toUpperCase()}`;

    const invoice = await createInvoiceRecord(prisma, ctx, {
      companyId,
      referenceNumber: ref,
      customerId: customer.id,
      customerName: customer.name,
      customerTin: customer.taxId,
      invoiceType: 'MANUAL',
      description: description?.trim() || 'Invoice',
      notes: notes?.trim() || null,
      terms: terms?.trim() || null,
      dueDate: due,
      lines: drafts,
    });

    // Charge the customer's ledger, exactly as the dispatch flow does.
    await createAccountTransaction({
      customerId: customer.id,
      companyId,
      transactionType: 'invoice',
      amount: Number(invoice.amount),
      description: invoice.description,
      dueDate: due,
      referenceNumber: invoice.referenceNumber,
    });

    audit(req, 'CREATE', 'Invoice', invoice.id, invoice.referenceNumber,
      `Invoice ${invoice.referenceNumber} raised for ${customer.name} — ${Number(invoice.amount).toLocaleString()} across ${invoice.lineItems.length} line(s).`);
    res.status(201).json(withInvoiceSummary(invoice));
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(400).json({ error: 'An invoice with that reference already exists.' });
    res.status(400).json({ error: err.message });
  }
});

/**
 * Edits an unpaid, unfiscalized invoice's header. Once URA has it, the figures
 * are fixed — the correction route is a credit note.
 */
app.patch('/api/invoices/:id', async (req, res) => {
  const companyId = getCompanyId(req);
  const id = parseInt(req.params.id);
  const { dueDate, description, notes, terms, customerTin } = req.body;
  try {
    const invoice = await prisma.invoice.findFirst({ where: { id, companyId } });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    if (invoice.efrisFDN) {
      return res.status(400).json({ error: 'This invoice has been fiscalized with URA. Issue a credit note to correct it.' });
    }

    const data: any = {};
    if (dueDate !== undefined) data.dueDate = new Date(dueDate);
    if (description !== undefined) data.description = String(description);
    if (notes !== undefined) data.notes = notes?.trim() || null;
    if (terms !== undefined) data.terms = terms?.trim() || null;
    if (customerTin !== undefined) data.customerTin = customerTin?.trim() || null;

    const updated = await prisma.invoice.update({ where: { id }, data, include: INVOICE_INCLUDE });
    audit(req, 'UPDATE', 'Invoice', id, invoice.referenceNumber, `Invoice ${invoice.referenceNumber} updated.`);
    res.json(withInvoiceSummary(updated));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Static client (hosted web deploy) ─────────────────────────────────────
// Serve the built React client from the same origin as the API so the browser
// hits /api/... on this host directly (no CORS, no hardcoded API URL). All API,
// sitemap/robots and /public/* routes are registered above and take precedence;
// any other GET falls back to the SPA's index.html for client-side routing.
// In the packaged desktop build Tauri serves its own webview and this directory
// is absent, so the whole block is a no-op there.
const CLIENT_DIST = process.env.CLIENT_DIST || path.join(__dirname, '..', 'client-dist');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path.startsWith('/api/')) return next(); // let unmatched API routes 404 as JSON
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
  console.log(`Serving static client from ${CLIENT_DIST}`);
}

startServer();
