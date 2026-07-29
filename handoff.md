# Project Handoff: YourHires Rental & Asset Management System

This document captures the current status, architectural blueprint, and immediate tasks for **YourHires** to ensure seamless continuation across agent sessions.

---

## 1. Project Context & Objectives
* **Goal:** Rebuild the Universal Staff & Asset Management System (USAMS) under the name **YourHires** as a stable, high-performance, and ledger-accurate web and desktop application.
* **Reference System:** We studied the architecture of [YourBooks Point of Sale](file:///d:/YourBooks%20Point%20of%20Sale) to inherit its visual standards (UXRishi 2025 Neomorphic theme, Light/Dark mode) and its packaging method (Tauri for lightweight desktop installation).
* **Scope:** Standard Rental & Asset Management (Customer/Function Bookings, deposits, dispatch logs, returns, serialized assets, late return penalties, invoicing, credit notes, and customer account ledgers) with multi-business scoping.

---

## 2. Technical Stack
* **Frontend:** React + Vite + Tailwind CSS (configured to run on port **`20091`** to avoid conflicts).
* **Desktop Wrapper:** Tauri (compiles React SPA client into a native lightweight `.msi` desktop installer).
* **Backend:** Node.js + Express + TypeScript (configured to run on port **`20090`** to avoid conflicts).
* **Database & ORM:** Prisma + MariaDB (configured to connect to MariaDB port **`3308`** to match the local database instance).
* **Auto-Provisioning on Local Desktop:**
  * Startup script checks if MariaDB is available locally on port **`3308`**.
  * If database `yourhires` does not exist, the boot script automatically executes `CREATE DATABASE yourhires`.
  * Boot script runs `npx prisma migrate deploy` to deploy schemas.

---

## 3. Current Progress
1. **Phase 1: Core Framework Initialization (COMPLETE):** Scaffolded Node.js backend inside `/server` and React client inside `/client`. Initialized Tauri setup.
2. **Phase 2: Database Schema Porting (COMPLETE):** Ported all 14 database models into `schema.prisma` and ran initial migrations in MariaDB.
3. **Phase 3: Neomorphic Layout & Styling (COMPLETE):** Configured CSS variables, neomorphic box shadow classes (`neo-outset`, `neo-inset`, active clicks), and light/dark theme toggles.
4. **Phase 4: Business Logic Porting (COMPLETE):** Implemented customer bookings, deposit confirmations, rental order dispatches, returns logging, and automatic late return fee audits.
5. **Phase 5: API Integration & Database Sync (COMPLETE):** Wired all frontend UI states and buttons directly to MariaDB database REST endpoints.
6. **Phase 6: Item & Serialized Asset Management (COMPLETE):** Built catalog creation forms and status track list tables in the UI and connected them to Express PATCH/POST routes.
7. **Phase 7: Enterprise Reporting & Aging Ledger (COMPLETE):** Implemented the Accounts Receivable Aging breakdown (Net 30, 31-60, 61-90, 90+ days overdue) calculated on backend and rendered on frontend dashboard.

---

## 4. Next Implementation Tasks
1. **Desktop Package Compilation (`npm run tauri:build`):**
   * Run Tauri build command to compile the lightweight desktop installer (`.msi` executable) and verify execution on Windows.
2. **Additional Rental Analytics:**
   * Build filters to narrow reports down by date-range, category, or customer name.
