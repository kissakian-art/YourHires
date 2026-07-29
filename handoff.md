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
- **Seed login:** `admin` / `password123` (also `staff`, `kampala_admin`). Company id 1 = "Mega Rentals Uganda Ltd". Passwords are bcrypt-hashed; legacy plaintext auto-upgrades on login.
- **Dev email:** no SMTP required — `server/src/email.ts` captures mail; inspect the last 10 at `GET /api/auth/dev-emails` to grab verification/reset tokens. Set `SMTP_*` env vars for real sending.
- A `.claude/launch.json` config named `yourhires-client` is set up for the Browser-pane preview tool.

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
| C — Tauri `.msi` desktop build verification | **← next up** |

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
