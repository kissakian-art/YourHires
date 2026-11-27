// midway-support.ts — server-to-server client for the central Midway Support desk.
//
// YourHires is a "channel" of the Midway desk: every call is authenticated with the
// channel API key (`x-api-key: msk_...`). This module is the ONLY place that holds
// that key — it must never be imported by / bundled into the React client. All
// support traffic is proxied through our own /api/support/* routes so the secret
// stays on the backend (the key authorizes ticket creation on behalf of the whole
// product, so a leak lets anyone file tickets as us).
//
// Source of truth for the remote API: SUPPORT_INTEGRATION.md (Midway core team).

const BASE = (process.env.MIDWAY_SUPPORT_BASE_URL || 'https://midwayug.com').replace(/\/+$/, '');
const KEY = process.env.MIDWAY_SUPPORT_API_KEY || '';

// The Midway "system" name this channel reports. Sent explicitly on every ticket so
// agents see which product a request came from regardless of the channel's own name.
export const SUPPORT_SYSTEM_NAME = process.env.MIDWAY_SUPPORT_SYSTEM || 'YourHires';

/** True once a channel key is configured. The client hides the support UI when false. */
export function isSupportConfigured(): boolean {
  return KEY.length > 0;
}

/** Thrown when the desk is reachable but answers non-2xx. `status` is the upstream
 *  code so our routes can forward something meaningful to the browser. */
export class MidwaySupportError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'MidwaySupportError';
  }
}

function assertConfigured() {
  if (!isSupportConfigured()) {
    throw new MidwaySupportError(503, 'Support is not configured on this server. Set MIDWAY_SUPPORT_API_KEY.');
  }
}

async function parseJsonSafe(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

// A dead or unreachable desk must surface as a clean 502, not an unhandled crash —
// support is a side feature and can never take down the app.
async function apiKeyFetch(pathname: string, init: RequestInit = {}): Promise<any> {
  assertConfigured();
  let res: Response;
  try {
    res = await fetch(`${BASE}${pathname}`, {
      ...init,
      headers: { 'x-api-key': KEY, ...(init.headers || {}) },
    });
  } catch (e: any) {
    throw new MidwaySupportError(502, `Could not reach the Midway support desk (${e?.message || 'network error'}).`);
  }
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new MidwaySupportError(res.status, data?.error || `Midway support API returned HTTP ${res.status}`);
  }
  return data;
}

export interface CreateTicketInput {
  requesterName: string;
  requesterEmail: string;
  subject: string;
  description: string;
  system?: string;
  requesterPhone?: string;
  externalUserId?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
}

// POST /api/support/tickets → { success, ticketRef, autoReply, ticket }
export async function createTicket(input: CreateTicketInput) {
  return apiKeyFetch('/api/support/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// GET /api/support/tickets/{ref} → { ref, status, messages, attachments, ... }
export async function getTicket(ref: string) {
  return apiKeyFetch(`/api/support/tickets/${encodeURIComponent(ref)}`);
}

// POST /api/support/tickets/{ref} → { success, status }  (adds a REQUESTER message)
export async function replyToTicket(ref: string, body: string, name?: string) {
  return apiKeyFetch(`/api/support/tickets/${encodeURIComponent(ref)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, name }),
  });
}

// GET /api/support/kb?q=&system= — public upstream (no auth), but we proxy it so the
// browser only ever talks to one origin. Returns { count, articles }.
export async function searchKb(q: string, system?: string) {
  const u = new URL(`${BASE}/api/support/kb`);
  if (q) u.searchParams.set('q', q);
  if (system) u.searchParams.set('system', system);
  let res: Response;
  try {
    res = await fetch(u);
  } catch (e: any) {
    throw new MidwaySupportError(502, `Could not reach the Midway knowledge base (${e?.message || 'network error'}).`);
  }
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new MidwaySupportError(res.status, data?.error || `Midway KB API returned HTTP ${res.status}`);
  }
  return data;
}

// Thread attachments come back relative to the Midway base; the browser renders
// them, so hand it an absolute URL.
export function absoluteAttachmentUrl(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return `${BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}
