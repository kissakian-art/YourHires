# YourHires — Missing Features vs. Original (usams_project)

Gap analysis comparing the original Django app at `C:\Users\user\Desktop\usams_project`
against the current Node/Express + React rewrite at `D:\YourHires`.

- **Original:** Django, ~40 models, 24 view modules, 178 templates.
- **New:** Express (`server/src/server.ts`, ~4900 lines) + React (`client/src/App.tsx`, ~10000 lines) + Prisma (~40 models).

> Method note: gaps were identified by route/model/keyword scans of the new codebase.
> Items marked ⚠️ *verify* should be confirmed at code level before scheduling work.

---

## ✅ Already ported (no action needed)

Bookings · Rental orders (dispatch / return / late-fee audit) · Customers + watchlist ·
Customer account ledgers with A/R aging · Items · Serialized assets (+ maintenance events) ·
Consumables (+ multi-unit UoM) · Employees · Sites · Function/events (checklist, issues,
activities, item load-out) · Suppliers · Purchase orders · Expenses · Payroll ·
Invoices · Credit notes · Income/revenue ledger · Audit log · Help center · System health/status.

---

## A. Confirmed DROPS (decided — leave out)

- [x] **Public storefront depth** — shopping cart (add/remove/update/clear/count), public item
      detail page, availability API, booking confirmation/payment/receipt pages, landing/terms/privacy.
      *Decision: dropped.* New keeps only the catalog list + basic booking POST.
- [x] **Legacy transaction system** — `LegacyTransaction` (old DB table `rentals_transaction`) was the
      OLD single-item rental model (one item / one customer / one checkout). It was **superseded by the
      Rental Order + line-items system, which is already fully ported** to the new app. Original left its
      URLs commented out. *Not a real gap — nothing to port.*

### Not applicable (never existed)
- **Client-facing event extras** (seating charts, guest RSVPs, digital contracts) — **zero references
  anywhere in the original code.** They appear only in `pendingOriginalfeatures.txt` as features an
  advisor recommended *against* building. There is nothing to port; listed here only to close the question.

---

## B. REAL gaps — unfinished work (grouped by priority)

### P1 — Core operational integrity

- [x] **Reconciliation & Alerts workflow** — ✅ DONE (2026-07-19). Rebuilt the rental-order return
      flow into a per-line reconciliation: capture returned / damaged / lost quantities, charge
      configurable damage + loss fees (% of replacement cost), write off damaged/lost stock, set
      serialized-asset terminal status (Available / Maintenance / Lost), and mark orders
      Returned vs Partially Returned. Added `GET /api/reconciliations` register (feeds an Alerts view).
      New reconciliation modal in Dispatches & Returns with live fee preview. Fee policy is
      business-configurable in **Settings → Business Settings** (per user decision).
      Server: `POST /api/rental-orders/:id/return`. Verified end-to-end (curl + browser).
- [x] **Server-side PDF generation** — ✅ DONE (2026-07-19). Added `pdfkit` (pure-JS, no Chromium —
      safe for the Tauri bundle) and a `server/src/pdf.ts` module with professional, reusable layouts
      that use real company data (name/address/phone). Endpoints: `GET /api/invoices/:id/pdf`,
      `GET /api/bookings/:id/receipt-pdf`, `GET /api/rental-orders/:id/pdf` (dispatch note with line
      items + fee totals). Client "PDF" / "Download PDF" buttons added to the invoices tab, dispatches
      tab, and the invoice/booking print modals (alongside the existing browser-print). `getCompanyId`
      now also accepts a `?companyId=` query param (for `window.open` links that can't set headers);
      company scoping enforced (404 on mismatch). Verified: valid PDFs, correct data, client wiring.
- [x] **Automated penalty invoice creation** — ✅ DONE (2026-07-19). Consolidated the two divergent
      late-fee code paths into one shared `computeLateFee` helper + idempotent
      `upsertPenaltyInvoice` / `chargeLedgerOnce` (deterministic refs `LFEE-`/`DMG-`, `-LF`/`-DF`).
      Both `apply-late-fee` and the return flow now auto-generate penalty invoices + ledger debits
      using the company-configurable late-fee rate. Removed the old random-ref duplicate invoice bug.
- [x] **Import for assets, consumables, employees** — ✅ DONE (2026-07-19). Added CSV import **and**
      export endpoints for all three (`/api/import/{assets,consumables,employees}` +
      `/api/export/...`), matching the existing customers/items pattern with sensible defaults + auto
      serial numbers. Client: the inventory Import/Export toolbar is now sub-tab-aware (items / assets /
      consumables) and the roster tab got Import/Export buttons; the shared import modal shows the
      correct expected columns per entity. Export headers == import headers (clean round-trip).
      Verified: API round-trips + browser wiring (assets export URL + modal columns).

> **Bonus fixes made while building P1** (both pre-existing bugs that blocked the feature):
> 1. `recalculateCustomerBalance` wrote a non-existent `lastPaymentDate` column on `CustomerAccount`
>    → threw on any account with a payment/credit. Added the column (migration) — ledger recalc now
>    works everywhere.
> 2. Admin nav gated on `currentUser?.role` instead of `currentUser?.user?.role`, so **Settings,
>    Revenue Ledger, Purchases & Payroll, and System Health were hidden from all users including
>    admins.** Fixed the role path — those tabs are now reachable.
>
> Also: the previously-cosmetic **Business Settings** panel (currency, terms, late fee) now actually
> persists via `PATCH /api/companies/:id/settings`, plus the new damage/lost/restock fields.
>
> ✅ *Related gap RESOLVED (2026-07-19):* the dispatch flow now decrements on-hand bulk-item stock
> and flips serialized assets to **Rented** (with an insufficient-stock guard + transactional
> rollback). The reconciliation return restocks good returns and leaves damaged/lost units out, and
> the dashboard utilization denominator is now `available + rented` so **Asset Utilization is accurate**.
> Full rent→return inventory loop verified: 450 → 440 (dispatch 10) → 447 (return 7 good; 3 damaged/lost stay out).

### P2 — Platform / user management

- [x] **Roles & company-user management** — ✅ DONE (2026-07-19). Full team management:
      `GET/POST/PATCH/DELETE /api/company/users` — list team, add members (enforces the plan's
      `maxUsers` seat cap), change role, activate/deactivate, remove. Guards the **last active admin**
      (can't demote/deactivate/delete the only admin). New **Team & Access** panel in Settings (admin-only)
      with a roster table (role dropdown, active toggle, remove) + Add-Team-Member modal; the current
      user is tagged "(you)" and can't remove themselves. Verified end-to-end (curl + browser add flow).
      *Scope note:* role is **Admin vs Staff** — the two tiers the app actually enforces (nav gating +
      financial redaction). Granular per-feature custom-role permissions from the Django `CompanyRole`
      model are **deferred** on purpose: nothing in the app reads a permission matrix today, so building
      one would be non-functional scaffolding. Revisit if per-feature access control becomes a real need.
      *Security debt (pre-existing):* passwords were stored/compared in plain text — **now RESOLVED
      in P2.2** (bcrypt hashing across seed/register/add-user/login/reset + migration of existing users).
- [x] **Email verification + password reset** — ✅ DONE (2026-07-19). New `AuthToken` table
      (single-use, expiring) drives both flows. Register issues a verification token + email;
      `GET /api/auth/verify-email?token=` verifies and shows a self-contained HTML page;
      `POST /api/auth/resend-verification` re-sends. Password reset: `POST /api/auth/forgot-password`
      (generic response, no user enumeration) → emailed link → `POST /api/auth/reset-password`
      (single-use, 1-hour expiry). Client: "Forgot password?" → email form → confirmation; the
      emailed `?resetToken=` link opens a Set-New-Password screen; an amber **verification banner**
      with Resend appears after login when unverified. **Password hashing folded in:** bcrypt on
      register/add-user/reset, login verifies hashes, legacy plaintext auto-upgrades on next login,
      and all existing users were migrated to hashes (resolves the earlier security-debt note).
      Verified end-to-end (curl + browser): reset, verify, banner, single-use/expiry guards.
- [x] **Real transactional email** — ✅ DONE (2026-07-19). New `server/src/email.ts` uses **nodemailer**:
      real SMTP when `SMTP_*` env vars are set, otherwise a dev "capture" transport (renders + logs +
      keeps a ring buffer at `GET /api/auth/dev-emails`) so flows are exercisable without a mail server.
      Styled HTML templates for verification + password-reset. (Wiring the remaining
      booking/overdue/low-stock notification emails onto this service is follow-on work.)
- [x] **In-app Notifications** — ✅ DONE (2026-07-19). New `Notification` (company-scoped) +
      `NotificationPreference` (per-user) tables. Notifications are auto-created from real events:
      **overdue** (scanner), **low_stock** (after dispatch/return, with dedupe), **return** processed,
      **payment** received (invoice pay + deposit), **new booking**. Endpoints: list (+unread),
      count (poll), mark-one-read, mark-all-read, get/put preferences. Client: **header bell with
      unread badge + dropdown panel** (category icons, click-to-read, mark-all-read, 60s poll) and
      **per-user alert-preference toggles** in Settings that filter what each member sees.
      Verified end-to-end (curl + browser): events create notifications, badge counts, read-state,
      and preference filtering (payments OFF → badge 1, ON → badge 2).

### P3 — Productivity / reporting

- [x] **Global search + saved searches** — ✅ DONE (2026-07-19). `GET /api/search?q=` searches
      customers, rental orders, bookings, items, serialized assets, invoices and staff, returning
      **grouped results** each tagged with the client tab that renders it. New `SavedSearch` table +
      CRUD endpoints. Client: a **header search box** with a debounced grouped-results dropdown
      (click a result → jumps to that tab), "Save this search", and a **saved-searches list** (empty
      query) to re-run/delete presets. Verified end-to-end (curl + browser): "sarah" → 8 grouped
      results, result-click navigation, saved-search create/list/re-run/delete.
- [x] **Reporting filters & extra reports** — ✅ DONE (2026-07-19). Turned out the **date-range /
      category / customer filters were already fully wired** on both the dashboard analytics AND the
      revenue ledger (client passes them; server honours them via `buildIncomeWhereClause`) — my
      earlier scan over-counted this gap. Added the genuinely-missing pieces: **filtered revenue-ledger
      CSV export** (`/api/export/income`, respects all active filters), a **site-activity report**
      (`/api/reports/site-activity` JSON + `/api/export/site-activity` CSV — the original's
      `site_report`), with client Export buttons on the Revenue and Client-Sites tabs.
      **Also fixed a real multi-tenant bug:** `invoice-aging` summed unpaid invoices across ALL
      companies (no `companyId` filter) — now scoped (verified co1=1,265,000 vs co999=0).
      Verified end-to-end (curl + browser): exports carry filters, aging scoping, site report.
      *(Platform-wide analytics remains part of the P5 super-admin console.)*
- [x] **Setup checklist / onboarding + tutorial** — ✅ DONE (2026-07-19). Setup checklist steps are
      **derived live from real data** (has an item/asset, a customer, a booking/order, >1 team member,
      public bookings enabled) via `GET /api/onboarding/status` — so it can never drift out of sync,
      auto-completes at 100%, and can be dismissed early (`POST /api/onboarding/dismiss`). Client:
      a dismissible checklist card at the top of the Dashboard with a progress bar; each step is
      clickable and jumps to the relevant tab. Added a lightweight 6-slide "Quick Tour" modal
      (Help & Support → "Take a Quick Tour") that walks Bookings → Dispatches → Ledgers → Inventory →
      Settings, navigating the underlying tab as you advance.
      **Also fixed a real bug found while building this:** `register` unconditionally set
      `onboardingComplete: true` on every new signup, so the checklist would never have shown for a
      real new company — now correctly starts `false`.
      Verified end-to-end: fresh company → 20% (only "public bookings" defaults true) → dismiss →
      persisted server-side; tour modal steps + tab navigation confirmed.

> **Follow-up flagged (not fixed, out of scope):** the Dashboard's "System Action Required" panel
> shows hardcoded placeholder alerts ("Sarah Kabasomi" watchlist/overdue) to every company regardless
> of their real data — confirmed on the fresh test company. Spawned as a separate task
> (`task_9a49283c`) rather than fixed here since it needs wiring to real watchlist/overdue data, not a
> one-line change.
- [x] **SEO surface** — ✅ DONE (2026-07-19). Discovered the **per-item entries already existed** in
      the per-company sitemap (booking pages were dropped with the storefront, so no per-booking
      entries are needed/applicable). Added the missing piece: a **global `GET /sitemap.xml`** —
      a sitemap index listing every active, publicly-bookable company's own sitemap — and a **global
      `GET /robots.txt`** at the domain root (where crawlers look by default), pointing at the index
      and disallowing `/api/` + `/admin/`. Gating matches the public catalog API exactly
      (`isActive && publicBookingsEnabled`). Verified: index lists both seed companies; a disabled
      company was correctly excluded.

### P4 — Function/event enhancements

- [x] **Function templates** — ✅ DONE (2026-07-29). New `FunctionTemplate` + `FunctionTemplateItem`
      models (ported faithfully from the original's Django models). Endpoints: list/create/delete
      templates, add/remove template items (item or asset + qty + notes), and
      `POST /api/function-templates/:id/create-function` which spins up a real `FunctionEvent` with
      the template's defaults (location/time/notes) and **pre-books** its items as
      `FunctionItemAssignment` rows (status `booked`). Client: a "Templates" management modal
      (Event Planner toolbar) to create templates, add items via item/asset pickers, and a "Use
      Template" inline form to launch a new event from it in one step.
- [x] **Function completion + signature capture** — ✅ DONE. Added `completedAt`/`completionNotes`
      to `FunctionEvent` + `POST /api/functions/:id/complete`. Signatures use a new
      `FunctionSignature` model (pickup/return/function types, signee name/contact, base64 PNG) +
      a from-scratch **canvas signature pad** (pointer events, no library) — matches the original's
      `signature_data` design exactly. Client: "Mark Complete" button (modal for completion notes,
      shows a green completed banner after) and "Capture Signature" button on the event drawer.
- [x] **Per-function expense / revenue recording** — ✅ DONE. New `FunctionExpense` model
      (expenseType/description/amount/date/receipt#) with `FunctionEvent.totalExpenses` recomputed as
      a live aggregate on add/delete (mirrors the original's approach). Revenue recording increments
      `FunctionEvent.totalRevenue` **and** posts to the consolidated Income ledger
      (`incomeSource: 'function_fee'`) — exactly matching the original's `record_function_revenue`
      service, so per-function P&L and company-wide revenue reporting stay in sync. Client: a new
      **Financials** tab on the event drawer showing live Revenue/Expenses/Net Profit cards, a record-
      revenue form, and an expense list with add/delete.
- [x] **Roster-linked task checklists (UI)** — ✅ Already existed (found during P4 investigation,
      not previously credited). The checklist "Add task" form already has a staff-assignee dropdown
      scoped to the function's actual roster (`selectedFunctionEvent.functionAssignments`), wired to
      `assignedEmployeeId` on create. No work needed — corrected the record.
- [x] **Printable BEO sheets** — ✅ Already existed (found during P4 investigation, not previously
      credited). `handlePrintBEO` already generates a full browser-print Banquet Event Order with
      roster, equipment load-out, checklist, and notes sections. No work needed — corrected the record.

> All P4 endpoints and UI flows verified end-to-end through the actual running app (not just curl):
> added an expense → P&L card updated live; recorded revenue → posted to Income ledger; drew and
> saved a real signature via the canvas pad → persisted as base64 PNG; marked a function complete →
> status + banner updated; created a template, added an item to it via the real item picker, then
> launched a brand-new function from it with pre-booked items — all confirmed via API after each UI
> action. Test data cleaned up; both projects type-check clean.

### P5 — Monetization / super-admin (only if productizing)

- [ ] **Real Stripe subscription billing** — checkout session, customer portal, webhook.
      New: client-side "Stripe Secure Test Checkout" **simulation** only; server has plan upgrade,
      no gateway/webhook.
- [ ] **Real Mobile Money payment** — UI dropdown + reference field only, no processing / proof
      submission flow (original: `mobile_money_payment`, `submit_payment_proof`).
- [ ] **Platform / super-admin console** — multi-company oversight, pending payment approvals,
      company account view, system admin metrics/settings.
      Original: `system_admin_views.py`, `admin_views.py`. Not ported.

---

## C. Build / packaging

- [ ] **Tauri `.msi` desktop build verification** — original pending item; run `npm run tauri:build`
      and confirm the installer launches on Windows.

---

### Decision (2026-07-19)
All of **Part B (P1–P5)** and **Part C** are committed as must-do. Section A is dropped/closed.

### Suggested order
1. P1 (reconciliation, PDF, penalty automation, imports) — operational correctness.
2. P2 (roles, email verify + real email, notifications) — multi-user readiness.
3. P3–P4 (search, reporting filters, SEO, function templates/BEO) — polish.
4. P5 (real Stripe/Mobile Money, super-admin console) + C (Tauri build) — monetization & distribution.
