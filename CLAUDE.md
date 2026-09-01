# CLAUDE.md — CRS Dispatch: complete app & business reference

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository. It's a full rewrite (2026-08-31) — previous versions of this doc covered only the
Field Squared integration in isolation; this version covers the whole app, every screen, every
integration, and the real business practices behind them. The old FS-integration deep-dive is
preserved below (Part 3) since it's still accurate and hard-won.

**Three other living docs complete the picture, deliberately not duplicated here — all now in
`notes/`:**
- [`notes/INTEGRATION-ROADMAP.md`](notes/INTEGRATION-ROADMAP.md) — the technical vision (a full
  Opportunity pipeline: dispatch → done → documented → billed → paid → margin-visible) and a
  dated log of what's shipped, parked, or in progress, with real numbers from checking
  assumptions live.
- [`notes/PROCESS-ADOPTION.md`](notes/PROCESS-ADOPTION.md) — the *separate* and equally important
  question of whether any of this actually gets used once built: org authority dynamics (who can
  and can't compel compliance), which enforcement ideas have actually worked, and a live-tracked
  list of known adoption failure points. **Read this before proposing "just add a required
  field."**
- `notes/parts-warehouse.md` is a **superseded design proposal** — a completely different,
  never-built object model (`Inventory_Location__c`/`Stock_Movement__c`/`Stock_On_Hand__c`) and it
  states Field Squared material requests are "PDF only, no structured data," which turned out
  false (see `materialReqs.js`, Part 4 below). What was actually built is `Available_Inventory__c`
  (Part 2, Parts tab), a much simpler single-object model. Don't treat that file as current state.

---

## Part 1 — What this app is

CRS Dispatch is the internal office/warehouse/finance tool for **CRS Building Automation
Systems** (fire alarm / access control / CCTV / intrusion / monitoring installer and servicer).
It's a Vite/React SPA backed by a Cloudflare Worker (Hono). **Salesforce is the single source of
truth** — this app holds no database of its own (aside from a D1 usage-analytics log, see below);
every screen reads/writes real Salesforce Opportunities, Accounts, Contacts, and a handful of
custom objects directly.

It sits at the center of three other systems, and a large fraction of this app's real value is
in the seams between them:

- **Salesforce** — the CRM/ERP of record. Opportunities are jobs. Everything (scheduling, status,
  quoting, billing records) revolves around the Opportunity.
- **Field Squared (FS)** — the field-service app technicians actually use on-site: work orders,
  status updates, and structured completion documents (`SERVICE_ACK`, `MATERIAL_REQ`,
  `TEST_INSPECTION`, ...). This app syncs Opportunities to FS work orders and reads FS's
  completion documents to auto-draft invoices/POs instead of office staff retyping them.
- **QuickBooks Online (QBO)** — the accounting system. Purchase Orders, Invoices, vendor/customer
  records. This app creates real QBO transactions (never just displays them) and reconciles QBO
  against Salesforce's own billing records.
- **crs-board** (a sibling repo/Worker, "the chalkboard") — the tech-facing mobile app.
  Technicians see their schedule and request time slots/time off there; this app is the office
  side of that negotiation loop (`scheduleRequests.js`), and the two Workers push live updates to
  each other via Cloudflare service bindings (see "Live push," Part 2).

Nobody at CRS uses this app for its own sake — every screen exists to remove a specific piece of
manual, error-prone, or simply undone busywork (retyping an invoice off a paper form, hunting for
which QBO customer an Account bills to, chasing whether a job's Salesforce status matches what FS
actually says). **[`notes/PROCESS-ADOPTION.md`](notes/PROCESS-ADOPTION.md) is the running diagnosis of why
some of that busywork still doesn't get replaced even once the tooling exists** — read it before
assuming shipping a feature here is the same thing as it getting used.

### Commands

Root (`package.json`):
- `npm run dev:web` — `cd web && npm run dev`, Vite dev server (default port 5173), proxies
  `/api/*` to `http://localhost:8787` (including WebSocket upgrades — needed for the TV board's
  live-push socket).
- `npm run dev:api` — `wrangler dev`, the real Cloudflare Workers runtime on port 8787. **Durable
  Objects (the TV board's live push) only work under this**, not under any plain-Node runner — run
  both `dev:web` and `dev:api` together in two terminals for full local fidelity.
- `npm run build` — builds the frontend (`web/dist`), required before a real deploy.
- `npm run deploy` — `npm run build && wrangler deploy`. One Worker serves both the built SPA
  (via the `[assets]` binding) and the API — same origin, so `web/src/api.js`'s calls are relative
  paths and there's no CORS to configure.

There is **no `server/package.json`** — the backend has no dependencies of its own beyond `hono`
(declared at the repo root); everything else (Salesforce/FS/QBO clients) is hand-rolled `fetch`,
no SDKs. `web/` is its own npm package (`vite`, `react`, `vite-plugin-pwa`).

### Repo structure

```
server/src/
  worker.js          — Worker entrypoint: fetch (Hono) + scheduled (Cron), route mounting, TvChannel DO export
  config.js           — THE file that knows this org's Salesforce/QBO field & object names (see below)
  salesforce.js        — SF client (Client Credentials OAuth, query auto-pagination, sendEmail)
  fieldSquared.js       — FS client (email/password auth exchange, KV token cache)
  quickbooks.js          — QBO client (refresh-token OAuth, query/queryAll/create — no update/delete)
  qboShared.js            — shared QBO helpers: matchItem, getUsableItems/getSalesItems (item caches)
  statusMap.js              — FS<->SF status tables + sfToFsStatus() (dispatcher-driven writes only)
  fsSync.js                  — Cron handler: link unlinked FS tasks to SF, sync status snapshot + assignments
  auth.js                     — office login: HMAC device tokens, no server-side session storage
  assignments.js                — createAssignment() and every shared assignment-writing helper
  scheduleRequests.js             — tech <-> office schedule-request negotiation loop (office side)
  parts.js                          — Available_Inventory__c: Add Inventory / Part Checkout / Service Stock
  purchaseOrders.js                   — Create PO (Job / Service Call / Service Stock paths) -> QBO PurchaseOrder
  invoices.js                           — Create Invoice (from FS SERVICE_ACK) -> QBO Invoice
  materialReqs.js                        — Create PO's material-req sourcing (FS MATERIAL_REQ documents)
  jobCost.js                               — Expense Tracking: quoted vs. actual cost per job
  tv.js / tvChannel.js / notifyTv.js         — /tv kiosk board + its Durable-Object-backed live push
  notifyBoard.js                              — live push to a tech's open crs-board tab (service binding)
  routes.js                                     — everything else: jobs/quotes/board, accounts/contacts/notes,
                                                    technicians/time-off, office users, usage analytics,
                                                    billing reconciliation (mounts every sub-router above)

web/src/
  App.jsx             — the entire office SPA (~10.5k lines) — see Part 2's screen tour
  TvBoard.jsx         — separate mount for the public, no-login /tv kiosk display
  api.js              — thin fetch wrapper, one function per backend route
  auth.js             — device-token storage, fetch-patching, login/logout
  styles.css          — global CSS (not component-scoped — see "conventions" below)
  main.jsx            — mounts <App/> at `/` and <TvBoard/> at `/tv` (no router; two separate trees)
```

### Architecture

- **Cloudflare Worker (Hono)** serves both the API and, in production, the built SPA (`[assets]`
  binding in `wrangler.toml`, `run_worker_first = ["/api/*", "/internal/*"]` so those paths never
  fall through to the SPA's own catch-all).
- **No database of CRS business data** — Salesforce is read/written directly on every request.
  The one piece of local state is a **D1 database** (`USAGE_DB`) holding internal usage-analytics
  events (`POST /track`), **shared with crs-board** (same `database_id` in both Workers'
  `wrangler.toml`) so the admin Usage dashboard can report on both apps at once.
- **KV** (`SF_TOKENS` binding) caches the Salesforce OAuth token, the Field Squared auth token,
  the FS task-scan list, FS search results, and a few other short-TTL lookups — despite the name,
  it's used by more than just SF token caching at this point.
- **One Durable Object** (`TvChannel`) — holds live WebSockets for connected `/tv` kiosk screens,
  using the WebSocket Hibernation API. This is the only stateful-connection piece in the whole
  app; everything else is stateless per-request.
- **Two Cloudflare service bindings**, both directions of a live-push relationship with
  crs-board: `BOARD` (this Worker calls crs-board to push a tech's open chalkboard tab) and
  crs-board's own binding back into this Worker (for TV-board pushes triggered by tech actions —
  see `/internal/tv-notify` in `tv.js`).
- **Cron triggers** (`wrangler.toml [triggers]`, both handled by `worker.js`'s one `scheduled()`,
  distinguished via `event.cron`): every 5 minutes, `runFsSync()` (`fsSync.js`) — links unlinked
  FS tasks to Salesforce Opportunities and refreshes the FS status/assignment snapshot the
  board's drift badge reads (see Part 3 for the full flow) — plus `rollupUsage()`
  (`usageRollup.js`), an idempotent recompute of the last 2 hours of `usage_events` into
  `usage_hourly_summary`, the table the Usage dashboard's aggregate queries actually read (added
  2026-09-01 once crs-board's rollout meant the raw event rate — and so the cost of re-scanning
  it on every dashboard call — was about to climb well past what caused the 6.8M-D1-reads/day
  incident). Once daily (`0 3 * * *`), also `purgeOldUsageEvents()` — trims raw `usage_events`
  past 120 days; `usage_hourly_summary` itself is never purged. New deployments: after applying
  `usage-schema.sql`, run `usage-summary-backfill.sql` once (same `wrangler d1 execute` pattern)
  so pre-existing history doesn't read as empty in the dashboard until it ages past the rollup's
  own 2-hour look-back.

### Auth (office login)

Dispatch requires login (email + password against the standard Salesforce `User` object via
three custom fields: `Password__c` — app-only plaintext, **not** the real SF login password, so
an admin can read a forgotten one; `Dispatch_Access__c` — may log in; `Dispatch_Admin__c` — the
Admin role). Blank `Password__c` falls back to `DEFAULT_OFFICE_PASSWORD` (env, default `'crs'`).

Login issues a **stateless HMAC device token** (`{name}` signed with `AUTH_SECRET`) — no
server-side session storage, ported directly from crs-board's own auth for the same reason (a
Worker runs many isolates; an in-memory session map would only exist on one of them). Critically,
**the token never carries the Admin role** — every admin-gated route re-reads
`User.Dispatch_Admin__c` live from Salesforce on each request (`getOfficeUser()` in `routes.js`),
so revoking admin access takes effect immediately, not on next login. `web/src/auth.js` patches
`window.fetch` once so every call automatically carries the bearer token, and a 401 anywhere
(other than the login call itself) clears the session and forces a reload to the login screen.

The **`/tv` kiosk display and `/internal/*` machine-to-machine routes are deliberately outside
this gate entirely** — mounted as separate Hono routers in `worker.js` so a public wall display
never needs a login, and so `/internal/tv-notify` (secret-gated by `X-Internal-Secret`, called by
crs-board's service binding) never collides with the office-login middleware.

---

## Part 2 — The whole app, screen by screen

The nav (`App.jsx`, `DispatchApp`) has no router — the active tab is a plain `tab` state string
persisted to `localStorage` so a hard refresh lands you back where you were. Admin-only tabs
(Billing, Expense Tracking, Usage) are hidden from the nav entirely for non-admins, not merely
blocked on click.

| Tab | Real-world workflow it replaces/supports |
|---|---|
| **Outstanding Jobs** | The main dispatch board. Every open Opportunity (Job / Service Call / Test & Inspection) that still needs office attention: assign techs, set/change date & time, watch Field Squared status, link a job to its FS work order, attach team notes. Status is **record-type-aware** — Service Call reads/writes `Service_Status__c`, Test & Inspection `Inspection_Status__c`, everything else (the ~47k legacy Opps with no record type, plus Job/Work_Order) `Project_Status__c`. `'Needs Quote'` is board-visible (a pre-quote site visit is a real, legitimate workflow, added 2026-08-25). `Monitoring` is excluded from the board entirely (both by record type and by the legacy `Opportunity_Type__c = 'Monitoring'` value). |
| **Tech Schedule** | Week/month calendar of tech assignments across every job at once, for capacity/time-off planning rather than job-by-job editing. Approved time off (real `Job_Assignment__c` rows against a hidden sentinel Opportunity) is fetched separately since it's invisible to the normal jobs query by design. |
| **Requests** | The office side of crs-board's tech-facing schedule-request negotiation — a tech proposes a date/time (or time off, or flags "New WO Required"); office Approves, Counters, or Denies. Backed by `scheduleRequests.js`. Sorted oldest-first on purpose ("age is the pressure that keeps the loop moving"). Resolved history is lazy-loaded, kept out of the default view. |
| **Contacts** | Salesforce Contact directory — search/filter, reassign which contact an Account uses for property/AP purposes, edit contact details via a modal (moved off inline-click-to-edit 2026-08-28 after a real bug where clicking a phone/email link to actually call/email it was being swallowed by the inline editor's own click handler). |
| **Accounts** | Customer/property directory grouped by management company, with overdue-billing and ready-to-bill flags per account (drives `BillingJobsModal`), and property/AP contact assignment. |
| **Quotes** | The quoting pipeline: Needs Quote → Ready for Review → Quote Sent, each a real status-field value (see "Salesforce record types," Part 3), plus a consolidated calendar view. Sending a quote or review email stamps `Sent_To_Customer__c`/`Ready_For_Review__c` — the status transition itself is a separate write, deliberately gated on the email actually succeeding. |
| **Parts** | Inventory tracking per job location (plus a shared "Service Stock" pseudo-job sentinel) — Add Inventory, Part Checkout, and **Create PO** (see Part 4 — as of 2026-08-31 a 3-way picker: Job, sourced from a Quote; Service Call, sourced from that one call's own Field Squared material req and billed to a real customer; Service Stock, pooling any number of service calls' material reqs into one PO against the fixed shared stock destination). `+ Invoice`/`+ PO` quick-actions also live directly on a service call's own row in Outstanding Jobs, launching the same wizards pre-filled. |
| **Billing** *(admin)* | Reconciles QuickBooks vs. Salesforce billed/received totals and cross-references invoice numbers present in one system but not the other — matched / QBO-only / SF-only, by date range/grouping/payment method. "QBO billed" only counts *sent* invoices (`EmailStatus=EmailSent`) — a real scoping distinction from "exists in QBO." |
| **Expense Tracking** *(admin)* | Per-job quoted-vs-actual cost: awarded amount, quoted labor/parts (from the real Quote, not re-derived by summing line items — see Part 4), real material PO spend, billed labor/parts/other split from live QBO invoice lines, FS-logged tech hours, and a materials-only profit figure (labor cost is deliberately never priced — "per-tech pay is sensitive," tracked in hours only). |
| **Usage** *(admin)* | Internal analytics on how office staff use this app itself (and, since the D1 table is shared, crs-board too) — KPIs, activity by day/time, by-screen usage, top actions, per-person drill-down, recent-activity feed. |

Header (always visible once logged in): CRS wordmark, global note search/create (`NotesMenu`),
**Manage Techs** (add/edit techs, set chalkboard password, pick a tech's TV-board color), **Office
Users** (admin-only — reset another office user's password/role, with a last-admin guard so the
final admin can't be demoted), a global refresh button, a live "Synced" indicator, and an account
menu (change password, log out, and a real build-timestamp footer — `__BUILD_TIME__`, baked in at
`vite build` — so staff can confirm a deploy actually reached their device rather than guessing
from whether something visibly changed).

### Shared building blocks (used across many screens, not per-screen concepts)

- **`useAnchoredPopover`** — the positioning hook nearly every custom dropdown/popover in the app
  is built on: flip above/below + horizontal clamp against viewport edges, closes on outside
  click/scroll/resize.
- **`FilterSelect`** — generic themed `<select>` replacement (`[value,label][]` options,
  portal-rendered) — a real native `<select>`'s open list can never be themed with CSS, so this
  replaced several actual `<select>` elements found live (Schedule's tech filter, Add Time Off's
  tech picker, every status select).
- **`SearchableSelect`** / **`OppMultiSelect`** / **`TechMultiSelect`** — searchable single/multi
  pickers, `[id, label][]` options, built generically (not opportunity-specific despite the name)
  and reused across Create PO/Invoice, Add Inventory, Part Checkout, assignment pickers.
- **`TypeFilterMenu`** — two-level cascading category → subtype flyout filter (Outstanding Jobs'
  "Type" filter, Expense Tracking's own type filter).
- **`DatePicker` / `MultiDatePicker` / `TimePicker`** — shared custom date/time inputs.
- **`Cascade` / `LazyCascade`** — the app-wide expand/collapse animation primitive
  (`ResizeObserver`-driven max-height transition, careful never to animate an already-closed
  initial mount). `LazyCascade` additionally defers mounting its children until first opened —
  used for genuinely large collapsible groups (Accounts' "No Management Company" bucket can hold
  thousands of rows, Parts' opportunity groups, an invoice list).
- **FS document pickers** — the "pick which real Field Squared document(s) to source lines from"
  card-list pattern (`.inv-doc-pick` cards) is shared in spirit across Create Invoice
  (`SERVICE_ACK`) and Create PO's material-req paths (`MATERIAL_REQ`) — see Part 4.
- **`NotesMenu` / `NoteEditModal` / `JobNotesBadge`** — the global team-notes system
  (`Dispatch_Note__c`), optionally linked to a specific Opportunity, visible/editable by any
  logged-in office user (no per-note ownership).
- **`FsDriftBadge`** — flags when a job's dispatch status contradicts its own FS status snapshot
  (display-only, see "Status sync" in Part 3 for why it's never auto-corrected).

### `/tv` — the warehouse/office kiosk board

A separate mount (`TvBoard.jsx`, not behind login, not part of the `App`/`DispatchApp` tree) meant
to be cast/mirrored to a wall-mounted TV — explicitly **no login, no clicks, no remote**. Rotates
every 45s through Day → Week → Month calendar views (tech-colored, using each tech's
`Technician__c.Color__c` or a deterministic fallback), plus pending schedule requests and approved
time off. Pushed live via a WebSocket to `TvChannel` (the Durable Object) — a 5-minute poll is
only a catch-up fallback if the socket drops. Kiosk hygiene: hard-reloads every 6h and polls
`index.html` for content changes every 10 minutes to self-deploy (nobody manually refreshes a
wall display), and a top-level error boundary reloads 15s after any render crash rather than
sitting on a dead screen.

---

## Part 3 — Salesforce & Field Squared integration (technical detail, still accurate)

### `config.js` — the one file that knows this org's names

Every Salesforce object/field API name and QBO org-specific id this app touches lives in
`server/src/config.js` — **the only file you should need to edit** if a field is renamed or the
org changes. Sections: `jobStatusValues` (the fallback board status list), `recordTypeStatus`
(the record-type → status-field resolver, below), `fields` (Opportunity), `objects`
(`Job_Assignment__c`/`Technician__c`), `scheduleRequest`, `dispatchNote`, `account`, `quotes`,
`invoicing`, `inventory`/`checkout`/`product` (Parts tab), `qbo` (PO/Invoice custom field
DefinitionIds, default expense account, due-on-receipt term id), `officeUser`.

### Opportunity record types (2026-08 restructure)

The org introduced Opportunity **record types**, each with its **own lifecycle status field**.
The ~47k pre-restructure Opportunities have no record type (`RecordType.DeveloperName` is null)
and keep their status in `Project_Status__c` — the default/fallback path, unchanged for them.

| `RecordType.DeveloperName` | Lifecycle status field | On the dispatch board? |
|---|---|---|
| `null` / `Default` / `Job` / `Work_Order` | `Project_Status__c` | yes |
| `Service_Call` | `Service_Status__c` | yes |
| `Test_Inspection` | `StageName` (Unscheduled/Scheduled/In Progress/Completed subset) | yes |
| `Monitoring` | `Monitoring_Status__c` | **no — excluded** |

One resolver decides everything: `statusFieldForType(devName)` in `config.js`, mirrored on the
frontend (`App.jsx`) and in crs-board's own `salesforce.ts` — **three hand-maintained copies that
must agree**; after any record-type or picklist change, verify all three. `Work_Order` rides
`Project_Status__c` on purpose (every real `Work_Order` Opp carries one; its
`Job_Or_Work_Order_Status__c` is only a coarse Active/Inactive flag). `boardStatusPredicate()`
(`routes.js`) builds one OR-branch per status field so Service Call/T&I jobs actually appear on
the board while Monitoring (record type *and* the legacy `Opportunity_Type__c` value) is excluded.

### Status mapping (`statusMap.js`) — one-directional, dispatcher-driven only

**No automatic process compares FS and SF statuses and writes a "winner," in either direction.**
A dispatcher-initiated SF status change is explicitly pushed to FS (`sfToFsStatus()`, called from
`PATCH /jobs/:id` and `assignments.js`); FS's status is never pushed back onto SF by anything
automated. The two are compared in exactly two display-only spots — the board's drift badge and
the cron's stale-snapshot re-check — comparison only, never a write. This replaced an earlier
bidirectional `reconcile()` (picked a "winner" by comparing last-modified timestamps) removed
2026-07-15 because an automatic write could silently overturn a status a human had just set. Both
comparisons are keyed **per record type** now (comparing against whichever field that type
actually uses), via hand-synced tables in `statusMap.js` (`FS_COMPAT_BASE` +
`FS_STATUS_COMPATIBLE_BY_TYPE`) and `App.jsx` (`compatTableFor`) — keep them in sync.

`sfToFsStatus(sfStatus, hasAssignments)` is assignment-aware: SF `Scheduled` maps to FS
`Assigned` once the job has ≥1 tech, otherwise plain `Scheduled`. If a status has no FS
equivalent, the FS write is silently skipped — intentional, not an error.

### Matching logic (FS task → SF Opportunity), `fsSync.js`

Three-tier match, run only for tasks with no `FS_Task_Id__c` yet, over a wide 1-year KV-cached
scan list (not just recently-modified tasks — the old narrow window stranded ~1.5k old unlinked
tasks that this rework recovered):

1. **Exact name match** — FS tasks are named identically to their SF Opportunity at creation.
2. **WO number parsed from the FS task name** (`"WO 53507 ..."` → SF `Name LIKE 'WO 53507%'`).
3. **LID match, Test & Inspection only** — T&I Opps are named by site/location and rarely share
   a name or WO number with their FS task; `LID + the 20xx year in the name + is-a-T&I +
   discrepancy-flag` is the only reliable bridge (a site gets a new T&I Opp yearly, so LID alone
   isn't unique).

A **uniqueness gate** refuses to guess when a key resolves to >1 candidate — left for a human via
the manual `fs-link` endpoint, replacing an old first-wins behavior that could mis-assign. Once
matched, `FS_Task_Id__c` is stamped and all future lookups for that pair are a direct SOQL query,
no more fuzzy matching. Tasks that match nothing go on a 24h KV skip-list so the cron doesn't
re-query them every 5 minutes forever.

**Structurally unmatched today ("Bucket 2"):** non-T&I tasks (service calls, jobs) whose SF Opp
isn't named identically and whose FS WO number isn't in SF at all — no shared per-job key exists
for these. The durable fix would be stamping a shared id (the SF Opportunity Id) into an FS
`Data` field at creation time, turning matching into an exact-key join; until then they stay
manual.

### Cron sync flow (`fsSync.js` → `runFsSync()`, every 5 minutes)

1. Re-entry guard (60s) via KV `fs_sync_last_run`, written **before** processing starts (so a
   crash mid-run doesn't wedge the next tick — the 5-minute overlap plus every write being
   idempotent makes reprocessing safe).
2. Build the linking candidate set: the wide cached scan list ∪ the narrow recently-modified
   list, deduped, `isLinkable` (name present, >3 chars — see "readiness gate" below).
3. Linking pass, capped at 30 tasks/run (bounds the run inside the Worker's time limit; the
   backlog drains gradually across ticks by design) — no status filter on candidate Opps,
   scoped only to `CreatedDate >= 1 year ago`.
4. Status snapshot + assignment sync, for tasks linked **and** modified in the last 10 minutes
   (plus a capped backfill batch with no snapshot yet): writes `FS_Status__c`/
   `FS_Last_Modified__c` unconditionally (display-only), then diffs FS `Users[]` against SF
   `Job_Assignment__c` rows — FS has a tech SF doesn't → create + notify; SF has a syncable tech
   (mapped `FS_User_Id__c`) FS no longer lists → delete + notify; techs with no FS mapping are
   left alone in both directions.

Errors on individual tasks are caught/logged — one bad task never kills the run.

### Write-through status update (`PATCH /jobs/:id`)

Single combined handler for status **and** scheduled-date changes (there's no separate FS-status
route). The record type decides which field a status write lands in. The SF write happens
**unconditionally first**; if a scheduled-date change triggers a crew release, incomplete
assignments' dates are cleared and techs notified; if the job has an FS link, the change is then
pushed to FS (status-only → `updateStatus`; date change → `getTask` + `patchTask` with Schedules).
**If the FS write throws, it's caught/logged with no rollback of the already-applied SF write** —
the response still returns 200 with `fsError` in the body, the client shows a toast and re-fetches
real state. This is a deliberate, standing decision, not a gap — see "conventions" in Part 5.

### Field Squared API facts (confirmed by testing)

- **Auth**: `POST /Authentication {Email, Password}` → `{AuthToken, Workspace, UserId}`.
  **Calling auth again immediately invalidates the previous token** — never call speculatively,
  only on a confirmed 401 or empty cache. `fieldSquared.js` auto-retries once on 401 (clear
  mem+KV, re-exchange, retry the original call).
- **Required headers**: `Content-Type`/`Accept: application/json`, `X-Workspace`, `X-Auth-Token`,
  `X-Client: 3`.
- **List tasks modified since**: `GET /{workspace}/api/task?modifiedsince={iso}` — compact shape,
  `User` field is **singular** (first assigned tech only).
- **Single task (full record)**: `GET /{workspace}/Task/{ExternalId}` — full record, `Users[]`
  (all assigned techs), `Data` blob, `Schedules`, `Events`. **Always use this** when accurate
  assignment data matters; the cron only uses the list endpoint to detect *what* changed.
- **Update a task**: `POST /{workspace}/api/task/{ExternalId}` — `Name`/`TaskType` are required
  even for a partial/status-only update. Real errors are in the `x-errorstatusmessage` response
  header, not the body. 200 with an empty body on success.
- **Documents**: `task.Documents` (or `.Docs[].ObjectId`) is a flat array of document ExternalId
  strings — the *only* scalable way to enumerate a job's FS documents. `/api/document`'s `?type=`
  filter returns a hard 400 on every value tried; an unfiltered call returns the org's **entire**
  ~12.7k-document/18MB corpus. Document fetch (`getDocument`/`listDocuments`) never throws or
  parses — returns `{status, ok, errHeader, body}` raw text; every caller `JSON.parse`s inside its
  own try/catch.
- **Document `Type` values seen live**: `SERVICE_ACK`, `MATERIAL_REQ`, `FRM4`, `TEST_INSPECTION`,
  `SA_NUMBER`. Repeating-row fields inside `Data` are fixed-size padded arrays (mostly `{}`
  placeholders) — filter on a reliably-present key, never trust array length.
- **Task type in use**: `"CCTV Job/Work Order"` — the only type currently synced.

### Readiness gate

`isLinkable(task)` — a task is eligible for the linking pass if it has a non-empty `Name` longer
than 3 characters. That's the entire gate today (looser than an earlier `VERIFY_CON_INFO === 'Yes'`
check this doc used to describe, which no longer exists in the code — worth confirming
intentional if half-built FS tasks start linking prematurely).

### Known edge cases and standing decisions (FS/SF)

- **Status sync is dispatcher-driven only** — no auto-write ever "wins" a disagreement; the drift
  badge exists to get a human to look, not to self-heal.
- **FS write failure never rolls back an already-succeeded SF write** — logged + surfaced as
  `fsError`, SF change stands.
- **Token invalidation race**: two concurrent Cron runs both hitting 401 would have the second
  re-exchange invalidate the first's token; the 401 retry-once logic handles it without looping,
  and in practice runs are sequential (5 min apart) so this isn't a real risk.
- **List endpoint `User` (singular) vs. single-task `Users` (array)** — always fetch the full task
  before writing/trusting assignment data.
- **`lastRun` is written at the very start of a cron tick**, not after processing — "resume near
  where the last run *started*," not "resume exactly where it left off," safe due to the 5-min
  overlap and idempotent writes.

### Things to verify during an FS/SF-focused audit

1. `fieldSquared.js`'s 401 retry clears both `mem.token` and KV before re-exchanging.
2. The bulk `WHERE FS_Task_Id__c != null` query relies on that field being External ID + Unique
   in SF (indexed) — confirm it still is.
3. **No status-writing code path exists outside explicit dispatcher actions** — never `fsSync.js`,
   never the `fs-link` endpoint. This is the property the 2026-07-15 fix established; watch for
   it creeping back.
4. `FS_COMPAT_BASE`/`FS_STATUS_COMPATIBLE_BY_TYPE` agree between `statusMap.js` and `App.jsx`, and
   their keys match `config.recordTypeStatus.fieldByType`.
5. `previousSfStatus` in the `PATCH /jobs/:id` handler is captured but never read — dead
   bookkeeping from a rollback path that no longer exists; confirm that's still intentional.
6. Every dispatcher-settable status (`ASSIGNABLE_STATUSES` and each `STATUS_VALUES_BY_TYPE` list
   in `App.jsx`) has an entry in `SF_TO_FS` (`statusMap.js`) — a missing one silently no-ops the
   FS side, which is fine for deliberately-FS-less statuses but not for accidentally-missing ones.
7. FS task names can contain single quotes (customer names) — `fsSync.js`'s batched match query
   escapes them (`.replace(/'/g, "\\'")`); verify every interpolated SOQL string in that file gets
   the same treatment, not just that one.
8. `worker.js`'s `scheduled` export calls `ctx.waitUntil(runFsSync(env))` — confirm it still
   returns a Promise.
9. `App.jsx`'s badge/status fields (`fsTaskId`/`fsStatus`/`fsLastModified`/`status`/`recordType`)
   all come from `shapeJob` (`routes.js`) — a badge silently going blank usually means a field
   dropped out of a board SOQL `SELECT` (`JOB_STATUS_SELECT` = `allStatusFields()` +
   `RecordType.DeveloperName` must be in every one).
10. **Record-type resolver agreement across all three copies** (server `config.js`, frontend
    `App.jsx`, crs-board `salesforce.ts`) — verify after any record-type or picklist change.
11. `isLinkable()`'s weaker-than-before gate (#Readiness gate above) — confirm intentional.
12. `App.jsx`'s job-category "Type" filter (`jobCategory`) buckets Job/Service Call/T&I/Other/
    Monitoring — only the four real record types are authoritative (`RECORD_TYPE_LABELS`);
    `Default`/`Work_Order` deliberately fall through to the explicit `OPP_TYPE_CATEGORY` table
    keyed by `Opportunity_Type__c` (a picklist value not listed there defaults to Job) — keep it
    in sync with the org's picklist.

---

## Part 4 — QuickBooks Online integration & the finance wizards

This is the newest and most actively-developed subsystem (built/extended across 2026-08-21
through 2026-08-31) — Create PO, Create Invoice, Billing Reconciliation, Expense Tracking, and
the Field Squared material-req sourcing that feeds Create PO's newer paths. It's what turns FS's
field-completion paperwork and Salesforce's own quote/job records into real QuickBooks
transactions, and reconciles the two systems against each other afterward.

### The QBO client (`quickbooks.js`) — exactly 4 methods

`createQbo(env)` returns `{getToken, query(soql), create(entity, body), queryAll(entity,
whereAndOrder)}`. **No update or delete method exists anywhere in this app** — every QBO write is
a `create`. Auth is refresh-token grant only (no client-credentials flow); the token **rotates on
every refresh** and must be persisted to KV before anything else uses it. `query` is single-page;
`queryAll` paginates. Entity names are **lowercase** for `create` (`'purchaseorder'`, `'customer'`,
`'item'`) and **capitalized** for `query`/`queryAll` (`'Customer'`, `'PurchaseOrder'`) — a real,
easy-to-get-backwards QBO API quirk.

### QBO's "Project" concept

A QBO "Project" is just a `Job:true` sub-Customer with a `ParentRef` to a real top-level Customer
— there's no separate Project entity. `GET /finance/qbo-projects` splits a plain `Customer` query
client-side into `{projects: [Job:true rows], parents: [everything else]}`.

### The crosswalk fields — this app's own memory, not populated by SF or QBO

- `Opportunity.QBO_Project_Id__c` — written the first time a PO resolves/creates a Project for
  that job, so every later PO against the same job reuses it instantly instead of re-matching.
- `Invoicing__c.QBO_Customer_Id__c` — stamped on every invoice Create Invoice creates; deliberately
  **not** an Account-level field (a single Account/property often spans many real paying tenants
  over its history — confirmed live, one real Account had ~20 different real payer names across
  its job history), so billing-customer suggestion is a ranked-frequency read per Account
  (`suggestCustomersForAccount`, `invoices.js`), never a single assumed-correct value.

Both crosswalks tolerate going stale (a Project/Customer deleted on the QBO side after the fact)
— nothing periodically reconciles them; a write failure just surfaces and the office re-resolves.

### Create PO (`purchaseOrders.js` + `materialReqs.js`)

`CreatePOPathPicker` (frontend) is the single entry point everywhere a PO can be started (Parts
tab's "+ Create PO", and a "+ PO" quick-action directly on a service call's own Outstanding Jobs
row) — it never assumes the path from context, always shows the 3-way choice:

1. **Job** — the original path (shipped 2026-08-21, hardened through several real-usage rounds).
   Multi-select the Opportunity/ies a PO covers (a real PO can legitimately span several jobs);
   per job, pick a Salesforce `Quote` to source lines from, or enter lines manually (confirmed
   live: `Awarded_Quote__c` is a display string not a working lookup, and ~40% of jobs have no
   linked Quote at all). Lines pool across selected jobs, grouped by vendor (a QBO PO is
   single-vendor); quantity/description prefill from the quote, **cost is always a fresh manual
   entry** (`QuoteLineItem.UnitPrice` is the customer sale price, not vendor cost). Resolves/
   creates a QBO Project per job via the crosswalk above.
2. **Service Call** — sources lines from that **one** service call's own Field Squared
   `MATERIAL_REQ` document(s) (`materialReqs.js`'s `GET /finance/material-reqs/:oppId` +
   `.../lines`, structurally almost identical to `SERVICE_ACK`'s own material rows, confirmed live
   2026-08-31 — line items in a 50-slot padded array, `Data.DTBL34`). Billed to a **real top-level
   QBO Customer** (not a Project), suggested via the exact same suggest-from-invoice-history logic
   Create Invoice uses, labeled "Billing customer account" — "this part is for this service and
   only this service," per direction. No Project involved at all.
3. **Service Stock** — pools `MATERIAL_REQ` documents from **any number** of different service
   calls (no restriction — every line still resolves to the same fixed destination regardless of
   source, so there's no billing ambiguity the way there would be pooling across different real
   customers). Always bills to the fixed Service Stock Opportunity's own QBO Project — resolved
   **silently**, no picker step at all, since it's genuinely never a decision: falls back to a
   known QBO Customer id (`SERVICE_STOCK_QBO_CUSTOMER_ID` env var) the first time (before the
   crosswalk field has ever been written), then self-heals onto the real Salesforce field via the
   normal write-back path from then on. Deliberately **no hard gate** — a Service Stock PO can be
   created with zero source service calls at all, since it's routinely a proactive purchase for
   work that hasn't happened (or been scheduled) yet, not only a reactive replenishment.

No material req at all, on any path, is a real and expected case (not just a fallback) — falls
back to manual line entry.

**Line-item plumbing, shared across all three paths**: `matchItem(items, code, name)`
(`qboShared.js`) — exact, case-insensitive match on code against Item `Name`/`Sku`, name fallback
against `Name` only, never fuzzy. Unmatched lines offer to create a real QBO Item (prefilled,
editable) rather than falling back to a generic "Materials" line. `APAccountRef` is required on
create (not defaulted, despite docs implying otherwise — found only by attempting a real create);
QBO's Item catalog here isn't account-mapped, so `AccountBasedExpenseLineDetail` with an explicit
`Materials` account is used, not `ItemBasedExpenseLineDetail` (which gets rejected). PO numbers
auto-generate (`YY-####`, matching the real human-entered scheme QBO's "Custom Transaction
Numbers" preference expects). The SF mirror write-back (an `Opportunity__c` "CRS Purchase Order"
record) is best-effort/non-blocking on every path.

**Never used for actual cost, on any path**: FS's own recorded price
(`CAT.PRICE`/`EQUIPMENT_MATERIALS[].CAT.PRICE`, a currency-formatted string) — real billing always
comes from the matched QBO Item's own `UnitPrice`. Confirmed live more than once: a real part's FS
price was found wildly off (one case ~4x) from what was actually billed.

### Create Invoice (`invoices.js`)

Drafts a QBO Invoice from a real FS `SERVICE_ACK` completion document instead of office staff
retyping it — office reviews and sends manually (this tool never auto-sends). Built and
live-verified against a real already-sent invoice; the drafted lines matched the real invoice's
own defaults almost exactly after several corrections found only by testing against that ground
truth:

- Which tech gets billed under their own per-employee QBO labor Item vs. the generic `Helper`
  item is decided by that row's `REP_TYPE` (`Installer` vs `Helper`) field, **not** by whether the
  tech has their own catalog item — a real tech with their own Item still bills as `Helper` when
  `REP_TYPE` says so.
- Visit grouping is by distinct calendar date across labor rows, not row count — multiple techs
  on the same date share one narrative note and one Truck Charges line. The doc's own top-level
  `DATE`/`DATE_COMPLETED` fields are confirmed unreliable (found reversed on a real document) and
  never used for this.
- Tax code comes from a plain `Taxable` boolean on the matched Item — there's no
  `SalesTaxCodeRef` field on these Items despite that looking like the obvious name.
- The "confirmed Service job" caution-banner gate is `Opportunity_Type__c`-based, not
  `RecordType` — ~44,000 of ~45,000 real Opportunities have no `RecordType` at all (the 2026-08
  restructure applies forward only), so gating on it would fire on virtually every real job.
- A non-blocking cross-check against this app's own `Job_Assignment__c` records (who was actually
  dispatched) vs. what the FS document's techs/dates say flags disagreement, never blocks sending.

### Billing Reconciliation (`routes.js`, admin-only)

Compares SF `Invoicing__c` against real QBO Invoices over a date range: billed/received totals,
and a matched/QBO-only/SF-only cross-reference with fuzzy pairing (amount-nearest, tie-broken by
same-day/same-customer/line-text similarity) — built to defend specifically against false
positives, since a wrongly-flagged "gap" burns trust fast (see `PROCESS-ADOPTION.md` item #4 for
why that matters for any future digest built on top of this). A separate one-off backfill route
(`/finance/qbo-id-backfill`) stamps the `QBO_Id__c`/`QBO_Customer_Id__c` crosswalk onto
already-existing `Invoicing__c` records from the same matched pairs, batched after hitting a real
Cloudflare "too many subrequests" ceiling on the full ~3,000-record backlog.

### Expense Tracking (`jobCost.js`)

Per-job quoted-vs-actual view. Quoted labor/parts/total are read straight from real Quote header
fields (`Total_Due__c`, `TOTAL_QLI_Labor__c`, `Sales_Tax__c`, `ShippingHandling2__c`), never
re-derived by summing line items (an earlier line-categorization approach silently dropped every
fee/permit/tax/shipping line — traced to a real customer-reported mismatch). Quote resolution is
a 4-tier fallback (`Awarded_Quote__c` prefix match → single Quote within 2% of Amount → sum of
all Quotes within 2% → most recent → none) — confirmed live only ~20% of Opportunities with an
`Awarded_Quote__c` value actually have a matching real Quote record. Billed-line categorization
into labor/parts/other is a hand-built heuristic on real QBO item names (per-tech "Lastname, F."
pattern, `Helper`, `Truck Charges`, retainage `.includes()` match) — unmatched lines default to
**parts**, not "other," since an unrecognized real part SKU is more likely than a genuinely
unclassifiable charge. Service-job material cost (which almost never has a real PO on file) is
*estimated* from each billed part's Product2 Standard Pricebook list price instead, flagged
`matched: false` when the join misses rather than silently dropped. Per-tech pay is deliberately
tracked in **hours only**, never dollars.

### Parts / Inventory (`parts.js`) — one level below the QBO wizards

`Available_Inventory__c` is a single flat object: one row per Opportunity+Product2 pair (a
"location" is either a real job Opportunity or the shared "Service Stock" sentinel). Add Inventory
and Part Checkout share one delta function (`adjustInventory`, `+qty`/`-qty` respectively) so the
two directions can't drift apart. `Price__c` and `PO_Number__c` are **live Salesforce validation
rules** (required) — worked around with a `0` price fallback and a literal `"N/A"` PO placeholder
where there's genuinely nothing to put. Batch writes are sequential, not `Promise.all` — a failed
line doesn't roll back earlier ones (see "no-rollback convention" below), and the frontend just
re-fetches. `Part_Checkout__c` rows are an append-only audit log, never updated after creation.

---

## Part 5 — Business practices, conventions, and org context

### The bigger picture this app is one piece of

`INTEGRATION-ROADMAP.md`'s pipeline diagram is the honest frame for everything above:

```
Opportunity → FS work order (linked) → FS documents (proof of work)
   → SF Invoicing__c (billed) → QBO invoice (sent) → payment received
   → vendor PO / actual material cost tied back in → real margin per job
```

Every arrow is a place the two sides can silently disagree or go missing — Create PO, Create
Invoice, Billing Reconciliation, and Expense Tracking each close one specific gap in that chain.
None of it was built speculatively — every one of those tools replaced a real, named manual habit
(retyping an invoice off paper, hunting for the right QBO customer, chasing down whether a job
got billed) that was already costing someone real time before this app existed.

### Org / authority context (full detail in `PROCESS-ADOPTION.md`)

Who's actually supposed to use most of these workflows day to day is **office/dispatch and
warehouse staff**, not field techs. The person building/maintaining this app has no authority to
compel Skip (co-founder, directs techs directly, will not use any system regardless of how easy
it is — this is refusal, not friction) or the techs who answer to him more than to the tooling.
Darryl (co-founder) wants enforcement but "can kind of scold a partner into doing it but won't do
it consistently." **The one thing confirmed to actually work: hard technical gates tied to a real
existing chokepoint someone already can't route around** (e.g. an accountant who controls
payment) — not visibility, not asking nicely, not a soft gate with an escape hatch. Read
`PROCESS-ADOPTION.md` before assuming a new field/report/reminder will change anyone's behavior.

### Recurring technical conventions (apply these by default; each was learned from a real bug)

- **No-rollback convention.** SF (or the primary) write happens first and stands even if a
  downstream write (FS, a batch line) fails — the failure is caught, logged, and surfaced to the
  UI, never silently retried into an inconsistent recovery. This is deliberate throughout the app
  (`PATCH /jobs/:id`, `assignments.js`, `parts.js`'s batch writes), not an oversight in any one
  file.
- **Fire-and-forget push, never blocking.** `notifyTech`/`notifyTv` (live push to crs-board/the TV
  board) always log-and-swallow their own errors — a delivery failure must never break the
  caller's already-successful Salesforce write.
- **CSS is not component-scoped.** `styles.css` is one global stylesheet — two components using
  the same generic class name (`.empty`, `.item`) silently collide, with source order or
  specificity deciding the winner. Prefer specific, collision-resistant class names. A rule inside
  a `@media (max-width: 768px)` block positioned earlier in the file than an unconditional rule of
  equal specificity targeting the same property gets silently overridden by source order — the
  established fix is `!important` on the mobile-scoped rule, not fighting file order.
- **No em-dash-style "--" anywhere in rendered/user-facing text** (per direction 2026-08-31) —
  fine in code comments (used extensively throughout this codebase as a house style, including in
  this file), never in JSX text nodes or any string a user can actually see (titles, hints, error
  messages, labels).
- **"Confirmed live" is a real citation in this codebase's comments**, not a figure of speech —
  a huge fraction of the business-rule comments throughout `server/src/*.js` and `App.jsx` record
  an actual empirical finding (a real record inspected, a real API call made, a real percentage
  measured) that overturned an earlier, more obvious-looking assumption. When extending a feature,
  the comment immediately above the code you're touching is very often the reason a naive
  "obviously correct" version was already tried and rejected — read it before re-deriving the same
  wrong assumption.
- **Every org-specific Salesforce/QBO name lives in `config.js`, never hardcoded elsewhere.**
- **New backend routes belong in a domain sub-router** (`parts.js`, `purchaseOrders.js`, etc.),
  mounted into `routes.js`'s `api` — not appended directly into the 2000+-line `routes.js` unless
  they're small and don't yet warrant their own file (contacts/accounts/notes/technicians/
  time-off/office-users/usage/reconciliation currently live there directly).

### Environment variables, secrets, and bindings

| Name | Kind | Set via | Used by |
|---|---|---|---|
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | secret | `wrangler secret put` | `salesforce.js` |
| `SF_LOGIN_URL` | var | `wrangler.toml` | `salesforce.js` |
| `SF_ORG_WIDE_EMAIL` | var | `wrangler.toml` | `salesforce.js` (quote-sent emails send as "CRS Updates") |
| `FS_EMAIL` / `FS_PASSWORD` / `FS_WORKSPACE` | secret | `wrangler secret put` | `fieldSquared.js` |
| `AUTH_SECRET` | secret | `wrangler secret put` | `auth.js` (office device tokens) |
| `DEFAULT_OFFICE_PASSWORD` | secret (optional) | `wrangler secret put` | `auth.js` — first-login fallback, default `'crs'` |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` / `QBO_REFRESH_TOKEN` | secret | `wrangler secret put` | `quickbooks.js` (refresh token rotates — re-persisted to KV on every use) |
| `QBO_REALM_ID` | var | `wrangler.toml` | `quickbooks.js` — the QBO company id, not sensitive on its own |
| `TIME_OFF_OPPORTUNITY_ID` | var | `wrangler.toml` | `assignments.js` — sentinel Opportunity, `FS_Task_Id__c` must stay null forever |
| `NEW_WO_OPPORTUNITY_ID` | var | `wrangler.toml` | `scheduleRequests.js` — "New WO Required" sentinel, same rule |
| `SERVICE_STOCK_OPPORTUNITY_ID` | var | `wrangler.toml` | `parts.js`, `purchaseOrders.js`, `materialReqs.js` — the shared stock bucket's real Opportunity Id |
| `SERVICE_STOCK_QBO_CUSTOMER_ID` | var | `wrangler.toml` | `purchaseOrders.js` — fallback QBO Customer id (`5766`) until the Salesforce crosswalk self-heals |
| `DISPATCH_TV_NOTIFY_SECRET` | secret | `wrangler secret put` | `tv.js` — gates `/internal/tv-notify` from crs-board's service binding |
| `BOARD_NOTIFY_SECRET` | secret | `wrangler secret put` | `notifyBoard.js` — must match crs-board's own `INTERNAL_NOTIFY_SECRET` |
| `CHALKBOARD_APP_URL` | var | `wrangler.toml` | tech-link generation |

Bindings (`wrangler.toml`): `SF_TOKENS` (KV — SF/FS token + misc short-TTL caches),
`USAGE_DB` (D1, **shared `database_id` with crs-board**), `TV_CHANNEL` (Durable Object,
`TvChannel` class), `BOARD` (service binding → the `chalkboard` Worker), `[assets]` (serves
`web/dist` in production).

---

## Part 6 — Things worth confirming before relying on this doc

This file was rewritten 2026-08-31 by reading the real, current code (not by trusting the
previous version of this doc, some of which had drifted from what shipped). Still worth spot
checking, same spirit as Part 3's audit checklist:
1. Whether `parts-warehouse.md`'s proposal has been formally abandoned/deleted, or is still being
   held onto for a future v2 — it's flagged above as superseded but the file itself hasn't been
   removed.
2. Whether `INTEGRATION-ROADMAP.md`'s "In progress — vision described, not yet built" section for
   Job/Project cost tracking should be updated now that Expense Tracking has actually shipped as
   an admin tab (Part 2/4 above) — the roadmap doc predates that shipment.
3. Whatever's newest in git log beyond this file's own last-edit date — this doc will drift the
   same way every doc in this repo has before it; the fix is the same each time: read the real
   code, not the doc, when they disagree.
