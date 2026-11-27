// Database backup & restore for YourHires.
//
// Whole-database logical backups via mysqldump, restore via the mysql client.
// Dependency-free: shells out to the MariaDB/MySQL client binaries (which ship
// with the DB) using spawn with an argument array (no shell) so DB credentials
// with special characters are passed safely. The DB password is handed to the
// child process via the MYSQL_PWD env var, never on the command line or in logs.
//
// Backups are timestamped files — a new backup NEVER overwrites an existing one.
// Retention only ever prunes the OLDEST files once the count exceeds the limit,
// and never the most recent backup. Pruning is done only AFTER a new backup is
// confirmed written, and only touches files matching this app's own name pattern.

import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env') });

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || '3308';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'yourhires';

// Anchor paths next to the server (server/backups, server/backup-config.json),
// matching how db.ts locates ../.env relative to this compiled module.
// In the packaged desktop build the server lives under Program Files (read-only),
// so YH_DATA_DIR points config + backups at a writable location (%APPDATA%).
const SERVER_ROOT = path.join(__dirname, '..');
const WRITABLE_ROOT = process.env.YH_DATA_DIR || SERVER_ROOT;
const CONFIG_PATH = path.join(WRITABLE_ROOT, 'backup-config.json');
const DEFAULT_DIR = path.join(WRITABLE_ROOT, 'backups');

// Only files created by this app are ever considered for listing or pruning.
// prerestore safety snapshots are listed but excluded from automatic pruning.
const BACKUP_RE = /^yourhires-(auto|manual|prerestore)-[\dT_-]+\.sql$/;
const PRUNABLE_RE = /^yourhires-(auto|manual)-[\dT_-]+\.sql$/;

export interface BackupConfig {
  enabled: boolean;      // auto-backup on/off
  hour: number;          // 0-23, local hour the daily backup targets
  retention: number;     // number of auto/manual backups to keep (min 1)
  dir: string;           // absolute path to the backup folder
}

const DEFAULT_CONFIG: BackupConfig = {
  enabled: true,
  hour: 3,
  retention: 14,
  dir: DEFAULT_DIR,
};

export function getBackupConfig(): BackupConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CONFIG.enabled,
      hour: Number.isInteger(raw.hour) ? Math.min(23, Math.max(0, raw.hour)) : DEFAULT_CONFIG.hour,
      retention: Number.isInteger(raw.retention) ? Math.max(1, raw.retention) : DEFAULT_CONFIG.retention,
      dir: typeof raw.dir === 'string' && raw.dir.trim() ? raw.dir : DEFAULT_CONFIG.dir,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveBackupConfig(patch: Partial<BackupConfig>): BackupConfig {
  const current = getBackupConfig();
  const next: BackupConfig = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    hour: Number.isInteger(patch.hour) ? Math.min(23, Math.max(0, patch.hour as number)) : current.hour,
    retention: Number.isInteger(patch.retention) ? Math.max(1, patch.retention as number) : current.retention,
    dir: typeof patch.dir === 'string' && patch.dir.trim() ? (patch.dir as string) : current.dir,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Locate the mysqldump / mysql client binary. Order: explicit env override,
// then the bare name (relies on PATH), then a handful of common Windows install
// locations. Returns the bare name as a last resort so spawn fails with a clear,
// actionable error rather than us guessing wrong.
function resolveBinary(name: 'mysqldump' | 'mysql'): string {
  const envKey = name === 'mysqldump' ? 'MYSQLDUMP_PATH' : 'MYSQL_PATH';
  const override = process.env[envKey];
  if (override && fs.existsSync(override)) return override;

  const exe = process.platform === 'win32' ? `${name}.exe` : name;

  // Is it already on PATH?
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(finder, [name], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split(/\r?\n/)[0].trim();
    if (found && fs.existsSync(found)) return found;
  } catch { /* not on PATH; fall through to common locations */ }

  const candidateDirs = [
    'C:\\xampp\\mysql\\bin',
    'C:\\Program Files\\MariaDB 11.4\\bin',
    'C:\\Program Files\\MariaDB 11.3\\bin',
    'C:\\Program Files\\MariaDB 10.11\\bin',
    'C:\\Program Files\\MariaDB\\bin',
    'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin',
    'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin',
  ];
  for (const dir of candidateDirs) {
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return name; // let spawn surface a clear ENOENT-style failure
}

function timestamp(): string {
  // 2026-08-02_0300 style — filesystem-safe, sorts chronologically as text.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface BackupFile {
  name: string;
  size: number;
  createdAt: string;   // ISO
  kind: 'auto' | 'manual' | 'prerestore';
}

export function listBackups(): BackupFile[] {
  const { dir } = getBackupConfig();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => BACKUP_RE.test(f))
    .map(f => {
      const st = fs.statSync(path.join(dir, f));
      const kind = (f.match(BACKUP_RE) as RegExpMatchArray)[1] as BackupFile['kind'];
      return { name: f, size: st.size, createdAt: st.mtime.toISOString(), kind };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
}

export function backupFilePath(name: string): string | null {
  // Guard against path traversal — only bare filenames matching our pattern.
  if (!BACKUP_RE.test(name)) return null;
  const { dir } = getBackupConfig();
  const full = path.join(dir, name);
  if (path.dirname(full) !== path.resolve(dir)) return null;
  return fs.existsSync(full) ? full : null;
}

// Delete oldest prunable backups once the count exceeds retention.
// Newest-first sort guarantees the retained slice always includes the most
// recent backup, so the current backup can never be pruned.
function pruneOldBackups(): string[] {
  const cfg = getBackupConfig();
  const prunable = listBackups().filter(b => PRUNABLE_RE.test(b.name)); // already newest-first
  const toDelete = prunable.slice(cfg.retention);
  const deleted: string[] = [];
  for (const b of toDelete) {
    try {
      fs.unlinkSync(path.join(cfg.dir, b.name));
      deleted.push(b.name);
    } catch { /* ignore individual failures; don't abort the backup */ }
  }
  return deleted;
}

export interface BackupResult {
  file: string;
  size: number;
  pruned: string[];
}

// Run mysqldump into a timestamped file. Resolves only after the dump is
// confirmed non-empty; on any failure the partial file is removed and NOTHING
// is pruned, so a failed backup never costs you an existing one.
export function runBackup(kind: 'auto' | 'manual' | 'prerestore' = 'manual'): Promise<BackupResult> {
  return new Promise((resolve, reject) => {
    const cfg = getBackupConfig();
    ensureDir(cfg.dir);
    const fileName = `yourhires-${kind}-${timestamp()}.sql`;
    const fullPath = path.join(cfg.dir, fileName);
    const bin = resolveBinary('mysqldump');

    const args = [
      '-h', DB_HOST,
      '-P', String(DB_PORT),
      '-u', DB_USER,
      '--single-transaction',      // consistent InnoDB snapshot without locking
      '--routines', '--events', '--triggers',
      '--default-character-set=utf8mb4',
      '--databases', DB_NAME,      // includes CREATE DATABASE + USE for clean restore
    ];

    const out = fs.createWriteStream(fullPath);
    const child = spawn(bin, args, {
      env: { ...process.env, MYSQL_PWD: DB_PASSWORD }, // keep password off argv
    });

    let stderr = '';
    child.stdout.pipe(out);
    child.stderr.on('data', d => { stderr += d.toString(); });

    const fail = (msg: string) => {
      try { out.close(); } catch { /* noop */ }
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch { /* noop */ }
      reject(new Error(msg));
    };

    child.on('error', (err) => {
      fail(`Could not run mysqldump (${bin}): ${err.message}. Set MYSQLDUMP_PATH in the server .env to the full path of mysqldump.exe.`);
    });

    child.on('close', (code) => {
      out.end(() => {
        if (code !== 0) {
          return fail(`mysqldump exited with code ${code}: ${stderr.trim() || 'unknown error'}`);
        }
        let size = 0;
        try { size = fs.statSync(fullPath).size; } catch { /* noop */ }
        if (size <= 0) {
          return fail(`Backup produced an empty file. ${stderr.trim()}`);
        }
        // Only now — after a confirmed, non-empty dump — do we prune.
        const pruned = pruneOldBackups();
        resolve({ file: fileName, size, pruned });
      });
    });
  });
}

// Restore the database from a backup file by piping it into the mysql client.
// Destructive: overwrites current data. Callers must take a pre-restore safety
// backup first (the API endpoint does this automatically).
export function restoreBackup(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const full = backupFilePath(name);
    if (!full) return reject(new Error('Backup file not found.'));
    const bin = resolveBinary('mysql');

    const args = [
      '-h', DB_HOST,
      '-P', String(DB_PORT),
      '-u', DB_USER,
      '--default-character-set=utf8mb4',
    ];

    const child = spawn(bin, args, {
      env: { ...process.env, MYSQL_PWD: DB_PASSWORD },
    });

    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', (err) => {
      reject(new Error(`Could not run mysql client (${bin}): ${err.message}. Set MYSQL_PATH in the server .env.`));
    });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Restore failed (code ${code}): ${stderr.trim() || 'unknown error'}`));
      resolve();
    });

    fs.createReadStream(full).pipe(child.stdin);
  });
}

// Delete a single backup by name (explicit admin action). Returns false if the
// name doesn't resolve to one of our backup files.
export function deleteBackup(name: string): boolean {
  const full = backupFilePath(name);
  if (!full) return false;
  fs.unlinkSync(full);
  return true;
}

export function getLastBackup(): BackupFile | null {
  const all = listBackups().filter(b => b.kind !== 'prerestore');
  return all.length ? all[0] : null;
}

// Scheduler tick: runs at most one auto-backup per day, once the configured hour
// has passed. If the machine was off through that hour, the next tick after boot
// catches up. Safe to call frequently (hourly) and on startup.
export async function maybeRunScheduledBackup(): Promise<void> {
  const cfg = getBackupConfig();
  if (!cfg.enabled) return;

  const now = new Date();
  const targetToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), cfg.hour, 0, 0, 0);
  if (now < targetToday) return; // configured hour hasn't arrived yet today

  const last = getLastBackup();
  const lastTime = last ? new Date(last.createdAt).getTime() : 0;
  if (lastTime >= targetToday.getTime()) return; // already backed up in today's window

  try {
    const res = await runBackup('auto');
    console.log(`[Backup] Auto backup written: ${res.file} (${(res.size / 1024).toFixed(0)} KB)` +
      (res.pruned.length ? `; pruned ${res.pruned.length} old backup(s).` : '.'));
  } catch (err: any) {
    console.error('[Backup] Scheduled backup failed:', err.message);
  }
}
