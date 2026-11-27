# Project Handoff: YourHires Rental & Event Management System

Continuation notes for a fresh agent session. For the detailed, line-by-line feature
checklist and history of what's been done, see **[MISSING_FEATURES.md](MISSING_FEATURES.md)**
— that file is the living source of truth; this document is the orientation summary.

---

## 1. What this project is

Rebuild of the Django "USAMS" rental/event management system as **YourHires**: a
Node/Express + TypeScript + React/Vite + Prisma/MariaDB app, packaged with Tauri for a
lightweight Windows desktop installer. Original reference app for feature-parity
comparison lives at `C:\Users\user\Desktop\usams_project`.

## 2. Stack & how to run it

- **Client:** React + Vite + Tailwind, port `20091`. `cd client && npm run dev`
- **Server:** Node + Express + TypeScript, port `20090`. `cd server && npm run dev` (ts-node-dev, auto-restarts)
- **DB:** MariaDB on port `3308`, database `yourhires`. Boot script auto-creates the DB and runs `prisma migrate deploy` if missing.
- **Demo data is opt-in:** set `SEED_DEMO_DATA=true` (and optionally `SEED_DEMO_PASSWORD=...`) on an empty DB to create `admin` / `staff` / `kampala_admin`. Without `SEED_DEMO_PASSWORD` a random one-time password is printed to the server log. Company id 1 = "Mega Rentals Uganda Ltd". Passwords are bcrypt-hashed; legacy plaintext auto-upgrades on login.
- **Dev email:** no SMTP required — `server/src/email.ts` captures mail; inspect the last 10 at `GET /api/auth/dev-emails` to grab verification/reset tokens. Set `SMTP_*` env vars for real sending.
- A `.claude/launch.json` config named `yourhires-client` is set up for the Browser-pane preview tool.

### ⚠️ Migration drift — FIXED 2026-08-02 (important for fresh deploys)
The committed migrations did NOT reproduce `schema.prisma` from empty (14 tables + 13 cols + 27 FKs had
only been applied via `db push` on the dev DB). `migrate deploy` onto a blank DB produced a broken schema
(e.g. missing `companies.currency_symbol`). Fixed with migration `20260802150000_reconcile_schema` (full
diff), marked already-applied on the dev DB via `prisma migrate resolve --applied`. Fresh installs
(desktop embedded DB, new servers, CI, teammate clones) now build the correct schema. If you spin up a
NEW empty DB, just run `prisma migrate deploy` — it now works.

### Self-contained desktop build (in progress)
`server/src/embedded-db.ts` + `server/src/desktop.ts` run the app against a bundled/portable MariaDB with
zero external DB. Verified: fresh embedded DB → migrations → seed → login, gated by `EMBEDDED_DB=true`.
Run it locally: from `server/`, `EMBEDDED_DB=true MARIADB_HOME=<mariadb-home> DB_DATA_DIR=<writable dir>
DB_PORT=3307 PORT=20090 npx ts-node src/desktop.ts`.

**Packaging (self-contained .msi) — DONE & verified via the built app (2026-08-03):**
- Build: `cd client/src-tauri && bash build-payload.sh` (stages node runtime + compiled server +
  node_modules incl. Prisma engines + prisma/ + portable MariaDB into `payload/`, ~444 MB), then
  `cd client && PATH="$HOME/.cargo/bin:$PATH" npm run tauri:build` → `YourHires_1.0.0_x64_en-US.msi` (~113 MB).
- `bundle.resources` ships `payload/`; `src-tauri/src/lib.rs` spawns the bundled Node server on release
  launch (env: EMBEDDED_DB, MARIADB_HOME, DB_DATA_DIR/YH_DATA_DIR under %APPDATA%, PORT 20090) and kills
  it on exit. Windows `\\?\` verbatim path prefix is stripped before spawning node.
- `migrate deploy` runs via the bundled Prisma CLI (no `npx`) with explicit `--schema`.
- Verified end-to-end by launching the built `app.exe`: it spawned the Node sidecar + embedded MariaDB,
  initialized the DB under `%APPDATA%\com.yourhires.app\data`, ran migrations + seed, served :20090
  (~6s), admin login OK, auto-backup written to `%APPDATA%\com.yourhires.app\backups`. Only a human's
  visual click-through of the native window remains (agent env can't screenshot it). build-payload.sh
  defaults MariaDB source to `C:/xampp/mysql` (override MARIADB_SRC); for a shippable product swap in
  official MariaDB portable binaries.

### Gotchas
- `prisma migrate dev` fails in this environment ("non-interactive"). Instead: edit `schema.prisma`, then generate SQL directly —
  `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<timestamp>_<name>/migration.sql`,
  then `npx prisma migrate deploy && npx prisma generate`.
- `prisma generate` fails with `EPERM` (locked query-engine DLL) if the dev server is running. Stop it first — on Windows, `pkill` doesn't exist, use PowerShell:
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'server\.ts|ts-node-dev' } | % { Stop-Process -Id $_.ProcessId -Force }`

## 3. Repo / git status

**Just initialized as a git repo this session** (it wasn't one before). One commit exists
locally (`Initial commit: YourHires rental & event management platform`) covering all
work through P4. **No remote is configured** — nothing has been pushed anywhere. If you
want this backed up to GitHub/GitLab/etc., add a remote and push:
```bash
git remote add origin <url>
git push -u origin main
```
`.gitignore` excludes `node_modules/`, `dist/`, `.env`, and Tauri build artifacts
(`client/src-tauri/target/`).

## 4. Feature-parity work status (see MISSING_FEATURES.md for full detail)

Compared against the original Django app and worked in priority order:

| Phase | Status |
|---|---|
| P1 — reconciliation, PDFs, penalty automation, imports, inventory loop | ✅ done |
| P2 — roles/team mgmt, email verify+reset, notifications | ✅ done |
| P3 — global search, reporting exports, SEO, onboarding checklist | ✅ done |
| P4 — function templates, completion/signatures, per-function P&L | ✅ done |
| P5 — real Stripe/Mobile Money, super-admin console | **skipped by user decision** |
| C — Tauri `.msi` desktop build verification | ✅ done (2026-07-30) |
| C — Automatic database backup & restore | ✅ done (2026-08-02) — `server/src/backup.ts` + Settings panel |
| Hardening — audit-log coverage expansion | ✅ done (2026-08-02) — `audit()`/`getActor()` + client `x-username` fetch patch |
| Hardening — desktop licensing (machine-locked) | ✅ done (2026-08-02) — `server/src/license.ts`, gated by `LICENSE_ENFORCED` env |
| P5 — Platform / super-admin console | ✅ done (2026-08-02) — superuser login → cross-tenant console; `x-admin-token` auth |
| Hardening — audit-log coverage expansion | ✅ done (2026-08-02) — `audit(req,...)` on ~32 mutations; actor via `x-username` |
| Tenant RBAC — custom roles & permission matrix | ✅ done (2026-08-02) — `CompanyRole` model; server-enforced; Settings → Roles & Permissions |

### Tenant RBAC notes (business-level roles & permissions)
- Data: `CompanyRole` (per-company, JSON matrix, `isSystemAdmin` built-in) + `UserProfile.companyRoleId`
  (migration `20260802130000_add_company_roles`). Catalog + helpers in `server/src/permissions.ts`
  (14 modules × view/create/edit/delete|manage).
- Boot `ensureCompanyRoles()` seeds Administrator (immutable, full) + Staff per company and back-fills
  existing users by old tier; register seeds them for new companies. Coarse `UserProfile.role`
  (Admin/User) is kept in sync for the last-admin guard.
- **Server enforcement** = route-table middleware near the top of `server.ts` mapping ~50 mutations +
  financial reads to (module, action); `requirePermission` also inline-guards role/user endpoints.
- **Auth identity — DB-backed session tokens** (`Session` model, migration `20260802140000_add_sessions`).
  Login/register issue `sessionToken`; client sends it as `x-session-token` on every `/api/` call and
  auto-logs-out on 401. `getPermissionContext` trusts ONLY a valid session (no token ⇒ 401), so the
  actor can't be forged via `x-username` (which is now audit-fallback only). `POST /api/auth/logout`
  invalidates it. 7-day expiry. In-memory `adminSessions` (super-admin console) is separate.
- Client: login returns `user.permissions` + `isSystemAdmin` + `roleName`; `can(module, action)` gates
  nav/financials/actions (backward-compatible with pre-RBAC localStorage sessions). Manage at
  Settings → Roles & Permissions (matrix editor); assign roles in Team & Access.

### Audit trail notes
- The general audit log (`AuditLog` + Settings → Notifications & Audit Log viewer) now covers creates,
  updates, deletes, financial ops (ledger, credit memo, payroll, PO status, function P&L) and bulk imports.
- Actor attribution: the client patches `window.fetch` (App.tsx) to send `x-username`; server reads it via
  `getActor(req)`. Header-less/system calls fall back to `'system'`. Consumable stock moves keep their own
  dedicated `consumableLog`; only consumable CREATE is mirrored to the general log to avoid double-logging.

### Super-admin console — operational notes
- **Login:** there is no default. Set `PLATFORM_ADMIN_USER` + `PLATFORM_ADMIN_PASSWORD` (12+ chars,
  optional `PLATFORM_ADMIN_EMAIL`) for ONE start, then remove them. `ensureSuperuser()` creates the
  account only if no superuser exists, and refuses (changing nothing) if the username/email is taken. **No self-service password change UI yet** — change via env or DB.
- A superuser has **no company/profile**; signing in shows the Platform Console instead of a tenant
  dashboard. Auth uses an `x-admin-token` bearer (12h in-memory session) — restart = re-login.
- **Suspend** a tenant = `Company.isActive=false` → its users get 403 at login. Reactivate to restore.
- The console's license-key generator needs the private signing key (`license-signing-key.pem`), so it
  only works on the vendor deployment — consistent with running the console there, not on desktops.

### Desktop licensing — operational notes
- **Enforcement is OFF by default.** To turn it on for the packaged desktop deployment, run the
  server with `LICENSE_ENFORCED=true` (optionally `LICENSE_TRIAL_DAYS` / `LICENSE_GRACE_DAYS`, default 14 each).
  Dev and the hosted web version leave it unset — the web keeps its own 30-day company trial.
- **Private signing key** lives at `server/license-signing-key.pem` (gitignored). It is the vendor
  secret used to issue keys — **move it somewhere safe and never ship it in the app bundle.** The
  matching public key is embedded in `server/src/license.ts`. If the private key is ever regenerated,
  update the embedded public key to match.
- **Issue a key:** customer reads their fingerprint from the app (license gate or Settings → Desktop
  License), then run `node server/scripts/gen-license.js --fp <FP> --days 365 --licensee "Name"` and
  send them the printed key to paste into the app.

**Next task (C):** run `npm run tauri:build` (or `npm run build:desktop` from the root
`package.json`) and confirm the installer actually launches on Windows. This is a
build/tooling verification, not a feature to design.

### Bugs found & fixed along the way (worth knowing about)
1. `recalculateCustomerBalance` wrote a non-existent `lastPaymentDate` column — fixed (migration added it).
2. Admin nav was gated on `currentUser?.role` instead of `currentUser?.user?.role` — Settings/Revenue/Payroll/Health tabs were invisible to everyone. Fixed.
3. `invoice-aging` report summed unpaid invoices across **all** companies (missing `companyId` filter) — real multi-tenant leak, fixed.
4. `register` unconditionally set `onboardingComplete: true` on every new signup — the setup checklist would never have shown. Fixed.
5. Dispatch didn't decrement bulk-item stock or flip serialized assets to Rented — utilization always read 0%. Fixed as part of P1.
6. **Password hashing was plaintext** — resolved in P2 (bcrypt everywhere, legacy auto-upgrade).

### Known follow-up in progress (background task)
A background task (`task_9a49283c`) was spawned to fix the Dashboard's **"System Action
Required"** widget, which shows hardcoded fake alerts ("Sarah Kabasomi" watchlist/overdue)
to every tenant regardless of real data. It's running in its own session — check its
status/PR before assuming it's done.

## 5. Working conventions established this session

- Every schema change: migration via `prisma migrate diff` (see gotcha above), then verified with curl **and** a real browser pass (login, click through, check server state after) before moving on — don't just trust curl.
- Test data created for verification is always cleaned up afterward (delete records, reset counters) so the seed DB stays in its original demo state.
- Money/fee policy (late fee %, damage %, lost %, restock toggle) is company-configurable in Settings → Business Settings, not hardcoded — this was an explicit user decision.
- Confirmed-dropped scope (do not rebuild): full public storefront (cart/checkout/receipt pages), legacy single-item transaction system (superseded by rental orders).
