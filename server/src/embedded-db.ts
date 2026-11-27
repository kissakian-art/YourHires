// Embedded MariaDB manager for the self-contained desktop build.
//
// On a machine with no MariaDB installed, the desktop app ships portable MariaDB
// binaries (bin/ + share/) and this module initializes a data directory in a
// writable location on first run, starts `mysqld` bound to localhost on a private
// port, waits until it accepts connections, and shuts it down cleanly on exit.
//
// Gated by the EMBEDDED_DB env flag (set by the desktop bootstrap). In dev/web the
// app keeps using the externally-managed MariaDB via the normal DB_* env vars.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, ChildProcess, execFileSync } from 'child_process';
import mysql from 'mysql2/promise';

export interface EmbeddedHandle {
  port: number;
  binDir: string;
  stop: () => void;
}

// Locate the portable MariaDB home (the dir containing bin/ and share/).
// Order: MARIADB_HOME env (set to the bundled resources dir in the desktop app),
// then a bundled ../mariadb folder next to the server, then a dev fallback (XAMPP).
function resolveMariaHome(): string {
  const candidates = [
    process.env.MARIADB_HOME,
    path.join(__dirname, '..', 'mariadb'),          // server/mariadb (bundled)
    path.join(__dirname, '..', '..', 'mariadb'),
    'C:\\xampp\\mysql',                               // dev fallback
    'C:\\Program Files\\MariaDB 11.4',
    'C:\\Program Files\\MariaDB 10.11',
  ].filter(Boolean) as string[];
  for (const base of candidates) {
    if (fs.existsSync(path.join(base, 'bin', 'mysqld.exe'))) return base;
  }
  throw new Error('Portable MariaDB not found. Set MARIADB_HOME to the folder containing bin/mysqld.exe.');
}

// Writable data directory. In the desktop app the bootstrap sets DB_DATA_DIR to
// %APPDATA%\YourHires\data; otherwise default under the user's home.
function resolveDataDir(): string {
  if (process.env.DB_DATA_DIR) return process.env.DB_DATA_DIR;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'YourHires', 'data');
}

function isInitialized(dataDir: string): boolean {
  // A populated MariaDB data dir has a `mysql` system-schema folder.
  return fs.existsSync(path.join(dataDir, 'mysql'));
}

async function waitForReady(port: number, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: any;
  while (Date.now() < deadline) {
    try {
      const conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' });
      await conn.query('SELECT 1');
      await conn.end();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 800));
    }
  }
  throw new Error(`Embedded MariaDB did not become ready within ${timeoutMs}ms: ${lastErr?.message || lastErr}`);
}

// Initialize a fresh data directory (first run only).
function initializeDataDir(home: string, dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const installExe = path.join(home, 'bin', 'mysql_install_db.exe');
  // Newer MariaDB ships `mariadb-install-db.exe` instead of `mysql_install_db.exe`.
  const altExe = path.join(home, 'bin', 'mariadb-install-db.exe');
  const exe = fs.existsSync(installExe) ? installExe : altExe;
  // NOTE: the Windows installer locates basedir relative to the exe; passing an
  // explicit --basedir makes some MariaDB builds fail, so we only give --datadir.
  execFileSync(exe, ['--datadir=' + dataDir], { stdio: 'ignore' });
}

// Start (initializing if needed) embedded MariaDB and resolve once it accepts
// connections. Returns a handle with a stop() for clean shutdown.
export async function startEmbeddedMariaDB(opts: { port?: number } = {}): Promise<EmbeddedHandle> {
  const home = resolveMariaHome();
  const binDir = path.join(home, 'bin');
  const dataDir = resolveDataDir();
  const port = opts.port || parseInt(process.env.DB_PORT || '') || 3307;

  // If a mysqld is already listening on the port (e.g. orphaned by a previous
  // hard app-kill that couldn't run our shutdown), reuse it instead of failing to
  // start a second instance against a locked data dir.
  try {
    const probe = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '', connectTimeout: 1500 });
    await probe.query('SELECT 1');
    await probe.end();
    console.log(`[EmbeddedDB] Reusing MariaDB already running on 127.0.0.1:${port}.`);
    return { port, binDir, stop: () => { /* not ours to stop */ } };
  } catch { /* nothing there — start our own below */ }

  if (!isInitialized(dataDir)) {
    console.log(`[EmbeddedDB] Initializing data directory at ${dataDir} ...`);
    initializeDataDir(home, dataDir);
    console.log('[EmbeddedDB] Data directory initialized.');
  }

  console.log(`[EmbeddedDB] Starting mysqld on 127.0.0.1:${port} ...`);
  const child: ChildProcess = spawn(path.join(binDir, 'mysqld.exe'), [
    '--no-defaults',
    '--basedir=' + home,
    '--datadir=' + dataDir,
    '--port=' + port,
    '--bind-address=127.0.0.1',
    '--skip-name-resolve',
  ], { stdio: 'ignore', windowsHide: true });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      // Ask mysqld to shut down cleanly (flushes + releases the data-dir lock).
      const admin = path.join(binDir, 'mysqladmin.exe');
      if (fs.existsSync(admin)) {
        execFileSync(admin, ['-h', '127.0.0.1', '-P', String(port), '-u', 'root', 'shutdown'], { stdio: 'ignore', timeout: 10000 });
      }
    } catch { /* fall through to hard kill */ }
    try { if (!child.killed) child.kill(); } catch { /* noop */ }
  };

  child.on('error', (err) => console.error('[EmbeddedDB] mysqld error:', err.message));

  await waitForReady(port);
  console.log('[EmbeddedDB] MariaDB is ready.');
  return { port, binDir, stop };
}
