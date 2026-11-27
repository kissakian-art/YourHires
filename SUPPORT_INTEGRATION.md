# Midway Support — System Integration Guide

_For developers of the Midway flagship systems (YourBooks ERP, YourBooks POS, YourBooks Mobile POS, YourMarket, YourHires, QuickBooks EIS Connector) who need to add an in-app **support** feature that files into the central Midway support desk._

Everything below is a live, implemented API — no SDK to install. If you can make an HTTPS request, you can integrate.

---

## 1. How it fits together

```
┌────────────────────────┐        x-api-key         ┌───────────────────────────┐
│  Your system            │ ───────────────────────▶ │  Midway Support API        │
│  (ERP / POS / YourMarket│   create ticket           │  (midwayug.com/api/support) │
│   / YourHires / QB-EIS) │ ◀─────────────────────── │                            │
│                         │   auto-reply + ref        │  • tickets  • KB search    │
│  in-app "Get Support"   │                           │  • agent/mobile API (JWT)  │
└────────────────────────┘        JWT Bearer          └───────────────────────────┘
                                     ▲
                          Midway agents / owner mobile app
```

- **Your system is a _channel_.** Each product authenticates with its own `x-api-key`.
- **Tickets are the unit of work.** A user in your app opens a ticket; Midway agents reply from the web console or the agent mobile app; your app can poll the ticket to show the thread and status.
- **The knowledge base is public.** Before a user files a ticket, search the KB so they can self-serve.
- **No email dependency.** The auto-reply and the whole conversation live in the ticket thread you fetch over the API.

---

## 2. Getting started

### 2.1 Get your API key
Ask a Midway admin to create a **Support Channel** for your system (Admin Console → Support Channels). You'll receive:

- a **channel name** (e.g. `YourBooks Enterprise ERP`)
- a **slug** (`erp`, `pos`, `yourmarket`, `yourhires`, `quickbooks`, …)
- an **API key** shaped like `msk_...` (56 hex chars). **Treat it as a secret.**

Keys can be **regenerated** by an admin (rotates the secret) and **deactivated** (all calls then return `401`).

> **Never ship the key in client-side code.** Call the support API from your **backend**. The key authorizes ticket creation on behalf of your whole system; a leaked key lets anyone file tickets as you.

### 2.2 Base URL

| Environment | Base URL |
|---|---|
| Production | `https://midwayug.com` |
| Local Midway dev | `http://localhost:4300` |

Put it in config:

```
MIDWAY_SUPPORT_BASE_URL=https://midwayug.com
MIDWAY_SUPPORT_API_KEY=msk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 3. Authentication

Two separate schemes — don't mix them:

| Caller | Scheme | Header |
|---|---|---|
| **Your system** (create/read tickets, KB) | Channel API key | `x-api-key: msk_...` |
| **Midway agent / owner mobile app** | JWT (from agent login) | `Authorization: Bearer <jwt>` |

The KB search endpoint needs **no** auth.

---

## 4. Endpoints your system uses

### 4.1 Create a ticket — `POST /api/support/tickets`

Auth: `x-api-key`. Accepts **JSON** or **`multipart/form-data`** (use multipart to attach screenshots).

**Fields**

| Field | Required | Notes |
|---|---|---|
| `requesterName` | ✅ | Also accepts `name` |
| `requesterEmail` | ✅ | Also accepts `email`; lower-cased server-side |
| `subject` | ✅ | |
| `description` | ✅ | Also accepts `message` |
| `system` | ⛔ | Defaults to your channel's name. Set it to be explicit (e.g. `"YourBooks POS"`) |
| `requesterPhone` | ⛔ | Also accepts `phone` |
| `externalUserId` | ⛔ | The logged-in user's id **in your system** — lets agents tie a ticket back to an account. Also accepts `userId` |
| `priority` | ⛔ | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT` (default `NORMAL`; invalid values fall back to `NORMAL`) |
| `screenshots` | ⛔ | **multipart only** — up to **5** files, each ≤ **5 MB**, `image/png\|jpeg\|webp\|gif` |

**Request (JSON)**

```http
POST /api/support/tickets
x-api-key: msk_xxxx
Content-Type: application/json

{
  "requesterName": "Grace Nakato",
  "requesterEmail": "grace@shop.co.ug",
  "requesterPhone": "+256772123456",
  "externalUserId": "user_8842",
  "system": "YourBooks POS",
  "subject": "EFRIS invoice stuck in queue",
  "description": "Sale #1042 has been 'pending fiscalization' for 20 minutes.",
  "priority": "HIGH"
}
```

**Response `201`**

```json
{
  "success": true,
  "ticketRef": "MID-SUP-3F9K2A",
  "autoReply": "Hi Grace, we've received your support request (MID-SUP-3F9K2A) about YourBooks POS. Hold on — one of our agents will get back to you shortly.",
  "ticket": {
    "ref": "MID-SUP-3F9K2A",
    "status": "OPEN",
    "priority": "HIGH",
    "system": "YourBooks POS",
    "createdAt": "2026-07-09T10:04:11.000Z"
  }
}
```

Show `autoReply` to the user immediately and **store `ticketRef`** against their account so they can track it.

**Errors:** `401` missing/invalid key · `400` missing required field or bad upload (unsupported type / >5 MB) · `500` server.

---

### 4.2 Read a ticket (status + thread) — `GET /api/support/tickets/{ref}`

Auth: `x-api-key`. Use for a "My support requests" screen. Poll it (e.g. every 30–60s while the screen is open) to show new agent replies.

**Response `200`**

```json
{
  "ref": "MID-SUP-3F9K2A",
  "system": "YourBooks POS",
  "subject": "EFRIS invoice stuck in queue",
  "status": "IN_PROGRESS",
  "priority": "HIGH",
  "createdAt": "2026-07-09T10:04:11.000Z",
  "updatedAt": "2026-07-09T10:12:44.000Z",
  "messages": [
    { "author": "REQUESTER", "name": "Grace Nakato",   "body": "Sale #1042 …",       "at": "…" },
    { "author": "SYSTEM",    "name": "Midway Support",  "body": "Hi Grace, we've …",  "at": "…" },
    { "author": "AGENT",     "name": "support@midway…", "body": "Hi Grace, retry …",  "at": "…" }
  ],
  "attachments": [
    { "name": "screenshot.png", "url": "/uploads/support/xxxx.png", "type": "image/png" }
  ]
}
```

Render the `messages` array in order as the conversation. `attachments[].url` is relative to the base URL. `404` if the ref doesn't exist.

---

### 4.3 Reply to a ticket (requester) — `POST /api/support/tickets/{ref}`

Auth: `x-api-key` (the **same** key you read the ticket with — call it server-to-server). This makes support a **two-way conversation**: the user in your app can post back into the thread, not just read agent replies. Accepts **JSON** or **`multipart/form-data`** (use multipart to attach screenshots).

**Fields**

| Field | Required | Notes |
|---|---|---|
| `body` | ✅ | The reply text. Also accepts `message` |
| `name` | ⛔ | Display name for the message. Defaults to the ticket's requester name |
| `screenshots` | ⛔ | **multipart only** — up to **5** files, each ≤ **5 MB**, `image/png\|jpeg\|webp\|gif`. Appended to the ticket's attachments |

```http
POST /api/support/tickets/MID-SUP-3F9K2A
x-api-key: msk_xxxx
Content-Type: application/json

{ "body": "Tried the retry — still stuck. Here's what I see now." }
```

**Response `201`**

```json
{ "success": true, "status": "IN_PROGRESS" }
```

Adds a `REQUESTER` message to the thread. If the ticket was `WAITING` (on the customer) or `RESOLVED`, the reply **re-opens it to `IN_PROGRESS`** so agents notice the new activity. After posting, re-fetch `GET /api/support/tickets/{ref}` to render the updated thread (any screenshots show up in the ticket's `attachments`).

**Errors:** `401` missing/invalid key · `400` empty body or bad upload (unsupported type / >5 MB) · `404` unknown ref · `409` the ticket is `CLOSED` (open a new request instead) · `500` server.

---

### 4.4 Search the knowledge base — `GET /api/support/kb?q=&system=`

**No auth.** Call this **before** showing the "create ticket" form so users can self-serve.

| Query param | Notes |
|---|---|
| `q` | free text; matched across title / problem / solution / tags |
| `system` | optional filter, e.g. `system=YourBooks POS` |

**Response `200`** — up to 10 published articles, most-viewed first:

```json
{
  "count": 2,
  "articles": [
    {
      "id": "…",
      "title": "Fixing a stuck EFRIS invoice",
      "slug": "fixing-a-stuck-efris-invoice",
      "system": "YourBooks POS",
      "category": "EFRIS",
      "problem": "Invoice pending fiscalization / stuck in queue",
      "solution": "1. Check network… 2. Retry from the queue…",
      "tags": "efris,queue,fiscalization"
    }
  ]
}
```

---

## 5. Recommended in-app flow

```
User taps "Get Support"
        │
        ▼
GET /api/support/kb?q=<their words>&system=<your system>   ← self-service first
        │  found a fix? → show article, done.
        ▼  still stuck?
Show ticket form (prefill name/email/phone/externalUserId from the session)
        │
        ▼
POST /api/support/tickets   → show autoReply + save ticketRef
        │
        ▼
"My requests" screen → GET /api/support/tickets/{ref} (poll) to show replies & status
        │
        ▼
User types a reply → POST /api/support/tickets/{ref}   ← two-way conversation
```

**Always prefill** `requesterName`, `requesterEmail`, `requesterPhone`, and `externalUserId` from the logged-in session — it saves the user typing and lets agents identify the account.

---

## 6. Reference client (TypeScript, server-side)

```ts
// midwaySupport.ts — call these from YOUR backend, never the browser.
const BASE = process.env.MIDWAY_SUPPORT_BASE_URL!;
const KEY  = process.env.MIDWAY_SUPPORT_API_KEY!;

export async function createTicket(input: {
  requesterName: string; requesterEmail: string; subject: string; description: string;
  system?: string; requesterPhone?: string; externalUserId?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
}) {
  const res = await fetch(`${BASE}/api/support/tickets`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
  return res.json(); // { ticketRef, autoReply, ticket }
}

export async function getTicket(ref: string) {
  const res = await fetch(`${BASE}/api/support/tickets/${encodeURIComponent(ref)}`, {
    headers: { 'x-api-key': KEY },
  });
  if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
  return res.json();
}

export async function replyToTicket(ref: string, body: string, name?: string) {
  const res = await fetch(`${BASE}/api/support/tickets/${encodeURIComponent(ref)}`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, name }),
  });
  if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
  return res.json(); // { success, status }
}

// Reply with screenshots — build multipart and let fetch set the boundary.
export async function replyToTicketWithFiles(ref: string, body: string, files: File[], name?: string) {
  const form = new FormData();
  form.append('body', body);
  if (name) form.append('name', name);
  for (const f of files) form.append('screenshots', f);
  const res = await fetch(`${BASE}/api/support/tickets/${encodeURIComponent(ref)}`, {
    method: 'POST',
    headers: { 'x-api-key': KEY }, // no Content-Type — fetch sets the multipart boundary
    body: form,
  });
  if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
  return res.json(); // { success, status }
}

export async function searchKb(q: string, system?: string) {
  const u = new URL(`${BASE}/api/support/kb`);
  if (q) u.searchParams.set('q', q);
  if (system) u.searchParams.set('system', system);
  const res = await fetch(u); // no auth
  return res.json(); // { count, articles }
}
```

**Attaching screenshots** (multipart) — build a `FormData`, append text fields plus each file under the key `screenshots`, and POST it with only the `x-api-key` header (let fetch set the multipart boundary).

---

## 7. Agent / owner mobile app (separate audience)

If you're building the **Midway-side** app that agents use to work the queue (not the customer-facing systems), these are JWT-authenticated:

| Endpoint | Purpose |
|---|---|
| `POST /api/support/agent/login` | `{ email, password }` (staff `ADMIN`/`STAFF`) **or** `{ password }` (owner master password) → `{ token, agent }` |
| `GET /api/support/agent/tickets?status=&system=` | Queue (max 100, newest first) + status counts |
| `GET /api/support/agent/tickets/{id}` | Full ticket detail (by **id**, not ref) |
| `POST /api/support/agent/tickets/{id}/reply` | `{ body, status? }` — adds an `AGENT` message; first reply auto-moves `OPEN → IN_PROGRESS`; `RESOLVED`/`CLOSED` set `resolvedAt` |

Send the token as `Authorization: Bearer <token>` on every agent call.

---

## 8. Reference data

**Ticket status:** `OPEN` → `IN_PROGRESS` → `WAITING` → `RESOLVED` → `CLOSED`
**Priority:** `LOW` · `NORMAL` · `HIGH` · `URGENT`
**Message author types:** `REQUESTER` · `AGENT` · `SYSTEM`
**Ticket source (set by the API):** `WEB` (site form) · `API` (your system) · `MOBILE`
**Ticket ref format:** `MID-SUP-` + 6 unambiguous chars, e.g. `MID-SUP-3F9K2A`
**Uploads:** ≤ 5 files/ticket, ≤ 5 MB each, `png` / `jpeg` / `webp` / `gif`

**CORS:** browser calls are allowed from `*.midwayug.com`, `*.infosolutions.co.ug`, and localhost. Because your systems live on their **own** domains, make support calls **server-to-server** (which also keeps the API key off the client) rather than from the browser.

**Error shape (all endpoints):**

```json
{ "error": "human-readable reason" }
```

with the HTTP status carrying the meaning (`400` validation, `401` auth, `404` not found, `500` server).

---

## 9. Not built yet (ask before assuming)

- **Webhooks / push** when an agent replies — poll `GET /api/support/tickets/{ref}` for now.
- **KB article view / "mark as helpful"** endpoints.

If your system needs any of these, raise it with the Midway core team — they're small additions to the existing routes under `app/api/support/`.

---

_Source of truth: `app/api/support/**`, `lib/support.ts`, `lib/cors.ts`, and the `SupportChannel` / `SupportTicket` / `KnowledgeArticle` models in `prisma/schema.prisma`. If this guide and the code ever disagree, the code wins — update this doc._
