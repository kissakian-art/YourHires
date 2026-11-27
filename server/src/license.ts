// Desktop licensing for YourHires — offline, machine-locked (node-locked).
//
// Model:
//  • A license is a signed token that binds to ONE machine's fingerprint, so a
//    key issued for machine A won't validate on machine B (stops casual sharing).
//  • Verification is fully offline: the server holds only the PUBLIC key; the
//    vendor (you) holds the private key and issues keys with scripts/gen-license.js.
//  • Unlicensed installs get a 14-day trial; an expired license gets a 14-day
//    grace period. After that the app is blocked until a valid key is entered.
//
// Enforcement is gated behind the LICENSE_ENFORCED env flag (set ON in the Tauri
// desktop build). It is OFF for dev and the hosted web version, which keeps its
// own 30-day company trial — this module never touches that.
//
// Honest limitation: offline node-locking deters sharing but cannot stop a
// determined cracker (the check runs on the user's machine). True revocation /
// hard seat-enforcement would require an online activation server.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const SERVER_ROOT = path.join(__dirname, '..');
const LICENSE_PATH = path.join(SERVER_ROOT, 'license.json');
const STATE_PATH = path.join(SERVER_ROOT, 'license-state.json');

export const LICENSE_ENFORCED = process.env.LICENSE_ENFORCED === 'true';
const TRIAL_DAYS = parseInt(process.env.LICENSE_TRIAL_DAYS || '14');
const GRACE_DAYS = parseInt(process.env.LICENSE_GRACE_DAYS || '14');
const DAY_MS = 24 * 60 * 60 * 1000;

// Public verification key (Ed25519, SPKI/PEM). Safe to ship. The matching
// private key lives only in server/license-signing-key.pem (gitignored) and is
// used by scripts/gen-license.js to issue keys.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAdkOBIHcU8v+RuMp9ppCM3hU5bd73202aLezLsHGW95U=
-----END PUBLIC KEY-----`;

// ── Machine fingerprint ────────────────────────────────────────────────────
// Derived from stable hardware identifiers. On Windows the MachineGuid is the
// most durable; we blend in the primary MAC + hostname so a fresh OS install
// (new MachineGuid) or a cloned disk on different hardware yields a new id.
function firstMac(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac;
    }
  }
  return 'no-mac';
}

function windowsMachineGuid(): string {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync('reg', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid',
    ], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

let _fingerprint: string | null = null;
export function getFingerprint(): string {
  if (_fingerprint) return _fingerprint;
  const parts = [windowsMachineGuid(), firstMac(), os.hostname(), os.platform(), os.arch()];
  const hash = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  // Group into a readable, transcribable block (users read this to the vendor).
  _fingerprint = hash.slice(0, 32).toUpperCase().replace(/(.{4})/g, '$1-').replace(/-$/, '');
  return _fingerprint;
}

// ── License token format ────────────────────────────────────────────────────
// "<base64url(payload JSON)>.<base64url(ed25519 signature)>"
// payload = { fp, exp (ISO), plan, licensee, iat (ISO) }
export interface LicensePayload {
  fp: string;         // machine fingerprint this key is bound to
  exp: string;        // expiry ISO date (empty string = perpetual)
  plan?: string;      // optional plan/tier label
  licensee?: string;  // who it was issued to (shown in UI)
  iat: string;        // issued-at ISO
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Verify signature + structure. Does NOT check fingerprint/expiry (callers do).
export function verifyLicenseToken(token: string): LicensePayload | null {
  try {
    const [payloadB64, sigB64] = token.trim().split('.');
    if (!payloadB64 || !sigB64) return null;
    const payloadBuf = b64urlDecode(payloadB64);
    const sig = b64urlDecode(sigB64);
    const ok = crypto.verify(null, payloadBuf, PUBLIC_KEY_PEM, sig);
    if (!ok) return null;
    const payload = JSON.parse(payloadBuf.toString('utf-8')) as LicensePayload;
    if (!payload.fp || typeof payload.fp !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Persisted trial/grace state ─────────────────────────────────────────────
interface LicenseState { firstRunAt: string; }
function getState(): LicenseState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    if (raw && typeof raw.firstRunAt === 'string') return raw;
  } catch { /* fall through */ }
  const fresh: LicenseState = { firstRunAt: new Date().toISOString() };
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(fresh, null, 2)); } catch { /* noop */ }
  return fresh;
}

function readStoredLicense(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf-8'));
    return typeof raw.key === 'string' ? raw.key : null;
  } catch {
    return null;
  }
}

// ── Status ──────────────────────────────────────────────────────────────────
export type LicenseStateName = 'licensed' | 'trial' | 'grace' | 'expired' | 'unlicensed';

export interface LicenseStatus {
  enforced: boolean;
  state: LicenseStateName;
  blocked: boolean;          // true when the app should be locked down
  fingerprint: string;
  daysLeft: number | null;   // days remaining in trial/grace, or until expiry when licensed
  expiresAt: string | null;
  plan: string | null;
  licensee: string | null;
  message: string;
}

function daysBetween(from: number, to: number): number {
  return Math.ceil((to - from) / DAY_MS);
}

export function getLicenseStatus(): LicenseStatus {
  const fingerprint = getFingerprint();
  const base = { enforced: LICENSE_ENFORCED, fingerprint, plan: null, licensee: null, expiresAt: null } as const;

  // When enforcement is off (dev / web), always report a non-blocking licensed state.
  if (!LICENSE_ENFORCED) {
    return { ...base, state: 'licensed', blocked: false, daysLeft: null, message: 'License enforcement disabled.' };
  }

  const now = Date.now();
  const token = readStoredLicense();
  if (token) {
    const payload = verifyLicenseToken(token);
    if (!payload) {
      // Present but invalid/tampered → treat as unlicensed trial context.
    } else if (payload.fp !== fingerprint) {
      return { ...base, state: 'unlicensed', blocked: true, daysLeft: 0,
        message: 'This license key was issued for a different machine.' };
    } else {
      const exp = payload.exp ? new Date(payload.exp).getTime() : 0;
      const plan = payload.plan || null;
      const licensee = payload.licensee || null;
      const expiresAt = payload.exp || null;
      if (!exp) {
        return { ...base, state: 'licensed', blocked: false, daysLeft: null, plan, licensee, expiresAt, message: 'Licensed (perpetual).' };
      }
      if (now <= exp) {
        return { ...base, state: 'licensed', blocked: false, daysLeft: daysBetween(now, exp), plan, licensee, expiresAt, message: 'Licensed.' };
      }
      // Expired → grace period from expiry.
      const graceEnd = exp + GRACE_DAYS * DAY_MS;
      if (now <= graceEnd) {
        return { ...base, state: 'grace', blocked: false, daysLeft: daysBetween(now, graceEnd), plan, licensee, expiresAt,
          message: `License expired — ${daysBetween(now, graceEnd)} day(s) of grace remaining. Please renew.` };
      }
      return { ...base, state: 'expired', blocked: true, daysLeft: 0, plan, licensee, expiresAt,
        message: 'License expired. Please enter a renewed license key to continue.' };
    }
  }

  // No valid license → trial window from first run.
  const firstRun = new Date(getState().firstRunAt).getTime();
  const trialEnd = firstRun + TRIAL_DAYS * DAY_MS;
  if (now <= trialEnd) {
    return { ...base, state: 'trial', blocked: false, daysLeft: daysBetween(now, trialEnd),
      message: `Trial — ${daysBetween(now, trialEnd)} day(s) remaining. Enter a license key to activate.` };
  }
  return { ...base, state: 'unlicensed', blocked: true, daysLeft: 0,
    message: 'Trial expired. Enter a valid license key to continue.' };
}

// Activate a pasted license key. Validates signature + fingerprint + non-expired
// (expired keys are rejected at activation — a still-in-grace renewal should use
// a fresh key). Persists on success.
export function activateLicense(key: string): { ok: boolean; status?: LicenseStatus; error?: string } {
  const payload = verifyLicenseToken(key);
  if (!payload) return { ok: false, error: 'Invalid or corrupt license key.' };
  if (payload.fp !== getFingerprint()) return { ok: false, error: 'This license key was issued for a different machine.' };
  if (payload.exp && new Date(payload.exp).getTime() < Date.now()) {
    return { ok: false, error: 'This license key has already expired.' };
  }
  try {
    fs.writeFileSync(LICENSE_PATH, JSON.stringify({ key, activatedAt: new Date().toISOString() }, null, 2));
  } catch (e: any) {
    return { ok: false, error: `Could not save the license: ${e.message}` };
  }
  return { ok: true, status: getLicenseStatus() };
}

// Sign a license token (VENDOR-side, e.g. the super-admin console). Requires the
// private key at server/license-signing-key.pem — present only on the vendor's
// deployment, never on a customer desktop. Mirrors scripts/gen-license.js.
const PRIVATE_KEY_PATH = path.join(SERVER_ROOT, 'license-signing-key.pem');
export function canSignLicenses(): boolean {
  return fs.existsSync(PRIVATE_KEY_PATH);
}
export function signLicense(opts: { fp: string; days?: number; plan?: string; licensee?: string }): string {
  if (!opts.fp || !opts.fp.trim()) throw new Error('A machine fingerprint is required.');
  if (!canSignLicenses()) throw new Error('Signing key not available on this server (vendor-only operation).');
  const priv = fs.readFileSync(PRIVATE_KEY_PATH, 'utf-8');
  const days = opts.days && opts.days > 0 ? opts.days : 0;
  const exp = days > 0 ? new Date(Date.now() + days * DAY_MS).toISOString() : '';
  const payload: LicensePayload = {
    fp: opts.fp.trim(), exp, plan: opts.plan || '', licensee: opts.licensee || '', iat: new Date().toISOString(),
  };
  const buf = Buffer.from(JSON.stringify(payload), 'utf-8');
  const sig = crypto.sign(null, buf, priv);
  const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url(buf)}.${b64url(sig)}`;
}

// Called once on boot so the trial clock starts on first ever run.
export function initLicense(): void {
  if (!LICENSE_ENFORCED) return;
  getState(); // materializes firstRunAt if absent
  const s = getLicenseStatus();
  console.log(`[License] enforced — state: ${s.state}${s.daysLeft != null ? `, ${s.daysLeft} day(s)` : ''}. Fingerprint: ${s.fingerprint}`);
}
