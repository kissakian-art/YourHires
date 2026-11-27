// Business-level role permissions (tenant RBAC).
//
// A company defines roles (CompanyRole) each carrying a permission matrix:
//   { moduleKey: { view, create, edit, delete } }  — or { manage } for admin-only areas.
// The built-in Administrator role (isSystemAdmin) always has full access and is
// not editable/deletable. Non-admin users get exactly the permissions their role
// grants. Enforcement happens both client-side (UI gating) and server-side
// (requirePermission middleware) so restrictions are real, not cosmetic.

// 'register', 'submit' and 'stock' exist only for URA EFRIS: reporting to the
// tax authority is not the same right as editing a record locally, so a clerk
// can raise an invoice without being able to file it with URA.
export type Action = 'view' | 'create' | 'edit' | 'delete' | 'manage' | 'register' | 'submit' | 'stock';

export interface ModuleDef {
  key: string;
  label: string;
  actions: Action[];
  financial?: boolean; // for grouping/labelling in the UI
}

// The permission catalog. Keys are stable identifiers used by both server
// enforcement and the client matrix UI.
export const MODULES: ModuleDef[] = [
  { key: 'dashboard',   label: 'Dashboard',            actions: ['view'] },
  { key: 'bookings',    label: 'Bookings',             actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'dispatches',  label: 'Dispatches & Returns', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'customers',   label: 'Customers',            actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'ledgers',     label: 'Customer Ledgers',     actions: ['view', 'edit'], financial: true },
  { key: 'inventory',   label: 'Items & Assets',       actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'staff',       label: 'Staff & Scheduling',   actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'events',      label: 'Events / Functions',   actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'revenue',     label: 'Revenue Ledger',       actions: ['view', 'create'], financial: true },
  { key: 'purchases',   label: 'Purchases & Payroll',  actions: ['view', 'create', 'edit', 'delete'], financial: true },
  { key: 'invoices',    label: 'Invoices',             actions: ['view', 'create', 'edit', 'delete'], financial: true },
  { key: 'creditNotes', label: 'Credit Notes',         actions: ['view', 'create'], financial: true },
  { key: 'efris',       label: 'URA EFRIS',            actions: ['view', 'manage', 'register', 'submit', 'stock'], financial: true },
  { key: 'settings',    label: 'Business Settings',    actions: ['manage'] },
  { key: 'team',        label: 'Team & Roles',         actions: ['manage'] },
];

export type PermissionMatrix = Record<string, Partial<Record<Action, boolean>>>;

// Every action of every module set to a given value.
function fill(value: boolean): PermissionMatrix {
  const m: PermissionMatrix = {};
  for (const mod of MODULES) {
    m[mod.key] = {};
    for (const a of mod.actions) m[mod.key][a] = value;
  }
  return m;
}

export const fullAccess = (): PermissionMatrix => fill(true);
export const noAccess = (): PermissionMatrix => fill(false);

// A sensible "Staff" starter role: can operate the day-to-day (bookings,
// dispatches, customers, inventory view, events) but NOT financials, settings,
// team, or deletions. Businesses can clone/tweak this.
export function defaultStaffPermissions(): PermissionMatrix {
  const m = noAccess();
  const grant = (mod: string, actions: Action[]) => { for (const a of actions) if (m[mod] && a in m[mod]) m[mod][a] = true; };
  grant('dashboard', ['view']);
  grant('bookings', ['view', 'create', 'edit']);
  grant('dispatches', ['view', 'create', 'edit']);
  grant('customers', ['view', 'create', 'edit']);
  grant('inventory', ['view']);
  grant('staff', ['view']);
  grant('events', ['view', 'create', 'edit']);
  return m;
}

// Normalize an arbitrary stored/incoming matrix to the known catalog: only known
// modules/actions survive, everything coerced to boolean. Prevents junk or
// privilege-escalation keys from being persisted.
export function sanitizeMatrix(input: any): PermissionMatrix {
  const clean = noAccess();
  if (input && typeof input === 'object') {
    for (const mod of MODULES) {
      const row = input[mod.key];
      if (row && typeof row === 'object') {
        for (const a of mod.actions) clean[mod.key][a] = !!row[a];
      }
    }
  }
  return clean;
}

// Effective permission check. isSystemAdmin (or the legacy coarse 'Admin' tier)
// always passes. Otherwise consult the matrix.
export function can(
  ctx: { isSystemAdmin?: boolean; permissions?: PermissionMatrix | null },
  moduleKey: string,
  action: Action
): boolean {
  if (ctx.isSystemAdmin) return true;
  const row = ctx.permissions?.[moduleKey];
  return !!(row && row[action]);
}
