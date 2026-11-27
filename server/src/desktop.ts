// Desktop entry point (used by the Tauri sidecar in the self-contained build).
//
// Starts embedded MariaDB, points the app's DB env at it, then boots the normal
// Express server (importing ./server runs startServer()). On the web/dev build
// this file isn't used — `src/server.ts` is the entry and talks to an external DB.

import path from 'path';
import os from 'os';
import fs from 'fs';
import { startEmbeddedMariaDB } from './embedded-db';

async function main() {
  let stopDb: (() => void) | null = null;

  try {
    // Establish a writable app-data base (%APPDATA%\YourHires) for the DB data
    // dir, backups, and config — the app itself is installed read-only.
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const dataBase = process.env.YH_DATA_DIR || path.join(appData, 'YourHires');
    fs.mkdirSync(dataBase, { recursive: true });
    process.env.YH_DATA_DIR = dataBase;
    if (!process.env.DB_DATA_DIR) process.env.DB_DATA_DIR = path.join(dataBase, 'data');

    const emb = await startEmbeddedMariaDB();
    stopDb = emb.stop;

    // Point the app (Prisma + mysql2) at the embedded instance. Must be set BEFORE
    // importing ./server, since PrismaClient reads DATABASE_URL at construction.
    const dbName = process.env.DB_NAME || 'yourhires';
    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = String(emb.port);
    process.env.DB_USER = 'root';
    process.env.DB_PASSWORD = '';
    process.env.DB_NAME = dbName;
    process.env.DATABASE_URL = `mysql://root@127.0.0.1:${emb.port}/${dbName}`;

    // Ensure MariaDB is shut down cleanly whenever this process ends.
    const shutdown = (code = 0) => { try { stopDb?.(); } finally { process.exit(code); } };
    process.on('SIGINT', () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));
    process.on('exit', () => { try { stopDb?.(); } catch { /* noop */ } });

    // Boot the API server (runs migrations, seeding, listeners).
    await import('./server');
  } catch (err: any) {
    console.error('[Desktop] Fatal boot error:', err?.message || err);
    try { stopDb?.(); } catch { /* noop */ }
    process.exit(1);
  }
}

main();
