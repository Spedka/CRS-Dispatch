# TODO — short-term, actionable

Living doc, covers **crs-dispatch + crs-board + scheduler-investigation** (the whole
dispatch/board system, not just this repo). For the bigger picture behind any of
this — why it matters, where it's headed — see [`ROADMAP.md`](ROADMAP.md).

Keep this current: delete an item the moment it ships, add one the moment it comes
up in conversation. A backlog nobody trusts is worse than no backlog — see
`PROCESS-ADOPTION.md`'s whole thesis on that, which applies to this doc too.

**Last swept:** 2026-09-01

---

## crs-dispatch

- [ ] **Usage-dashboard D1 numbers — check back once crs-board's rollout has real login
  data.** `usage_hourly_summary` (schema + one-time backfill both applied 2026-09-01) is live;
  `GET /usage`/`GET /usage/user` read it instead of scanning raw `usage_events`, and a cron keeps
  it current + purges raw history past 120 days. Projected daily D1 reads land comfortably under
  the 5M cap even at 5–10× growth — worth a real-numbers check against that projection once techs
  are actually logging into crs-board (Cloudflare dashboard → D1 → `dispatch` → Query Analytics,
  or `GET /usage` itself). If 30/90-day dashboard views turn out to be routine rather than
  occasional, or the real event rate comes in well above the projection, the next lever is a KV
  snapshot-plus-delta layer on top of the rollup table (discussed, not built — makes per-view cost
  stop scaling with the day-range at all, at the cost of a real correctness trap on distinct-actor
  counts that needs care to get right).
- [ ] **CRS Schedule (office tasks/events) — built, blocked on you creating
  schema in Salesforce.** Tech Schedule tab renamed "CRS Schedule," office
  users can now create/assign tasks (optionally linked to a job, optionally
  "time sensitive" — a due date/time instead of a start/end window) to other
  office users, who get emailed and see a badge on the tab until they
  accept/decline; a unified All/Techs/Office/per-person filter now governs
  both Week and Month view (Month now has a mobile agenda-list fallback too,
  same as Week), office rows sit above tech rows with your own row pinned to
  the top (Week) or highlighted (Month), and tasks have notes via the same
  shared Dispatch_Note__c system jobs already use. **Needs before it'll
  actually run:** two new objects, `Dispatch_Task__c` (`Name`,
  `Description__c`, `Start_Date__c`, `Start_Time__c`, `End_Date__c`,
  `End_Time__c`, `Time_Sensitive__c` checkbox, `Status__c` picklist
  Open/Completed/Cancelled, `Opportunity__c` lookup) and
  `Dispatch_Task_Assignee__c` (`Task__c` lookup — Child Relationship Name
  `Task_Assignees` — `User__c` lookup, `Response_Status__c` picklist
  Invited/Accepted/Declined, `Responded_At__c`), plus one new lookup field
  on the existing `Dispatch_Note__c` (`Task__c`, lookup → Dispatch_Task__c).
  Once those exist, this should just work — nothing else to build first.
- [x] **Create PO: Service Call + Service Stock paths.** Job-path Create PO
  (Parts tab → "+ Create PO") is shipped and sources lines from a Quote. Two more
  paths are designed but not built:
  - **Service Call** — sources lines from that one service call's FS material-req
    doc(s) (confirmed real, `Type: MATERIAL_REQ`, same line shape as
    `EQUIPMENT_MATERIALS`). `CustomerRef` resolves to a real top-level QBO
    Customer (reuse `invoices.js`'s `suggestCustomersForAccount`), no Project
    involved.
  - **Service Stock** — pools material-req docs across any number of service
    calls, always resolves to the fixed Service Stock Opportunity
    (`006Uh00000xQHpfIAG`) via the existing Project crosswalk.
  - Both need: a "Create PO" path-picker (Job / Service Call / Service Stock)
    shown from every PO entry point, not just Parts; a material-req line-fetch
    endpoint (`extractMaterials()` pointed at `Data.DTBL34` instead of
    `Data.EQUIPMENT_MATERIALS`); a `POST /finance/purchase-orders` branch that
    accepts a plain `customerId` and skips Project resolution.
  - **Open decision:** should a Service Stock PO record which real service
    call(s) contributed, for audit purposes? Leaning "not necessary" but never
    confirmed.
- [ ] **Invoice drafting.** The feature Create PO was explicitly built toward
  ("for invoice drafting and margin visibility, eventually") — not designed yet.
- [ ] **ADI vendor price sync.** Blocked on ADI's side (waiting on a response
  about electronic catalog access — checking whether their portal offers a bulk
  price-list export before pursuing a formal XML/FTP feed). Once they respond:
  get a sample export, confirm it carries real manufacturer SKUs, build the
  `Product2`/`PricebookEntry` importer.
- [ ] **"Documentation" window.** Cross-check billed invoices against FS
  `SERVICE_ACK`/`TEST_INSPECTION` proof docs. Validated real and small (94% of
  billed FS-linked jobs have a proof doc; the 6% gap is real and actionable) —
  deliberately parked, not started.
- [ ] **End-to-end pipeline visibility.** A per-Opportunity view showing every
  stage (quote → PO → schedule → invoice) at once. Not designed — may fall out
  naturally once the pieces above exist, or may need its own screen.

## crs-dispatch — process/ops decisions (not code, need a human call first)

- [ ] **PO approval as a real hard gate.** Check whether QBO Bills/Expenses are
  already job-tagged when the accountant enters them — if yes, real vendor cost
  per job may already exist without building anything new.
- [ ] **Material requests.** Same "made, then lost" pattern as POs. Not yet
  explored separately.
- [ ] **Invoice follow-up digest.** Agreed useful in principle; cadence,
  audience, and confidence-threshold (start conservative — only flag gaps stale
  N+ days, not transient data-entry lag) all still undecided.
- [ ] **Mid-day redirects via Skip.** The one real unsolved case: Skip dispatches
  a tech and nothing touches the system until after the work is done — no
  billing-status check, no SERVICE_ACK possible. No current tooling lever
  reaches this (GPS tracking status unknown — pending a question to Field
  Squared support; escalation to Darryl is inconsistent). Only idea on the table
  is an unvalidated tech-initiated one-tap "started here."
- [ ] **Parts checkout enforcement.** Used to be enforced by a warehouse
  employee who's since left; nothing replaced that function. Needs a decision
  between a physical/hardware gate, a cheaper single-barrier cage-unlock scan, a
  software-only checklist (honor-system unless paired with a physical block), or
  hiring a replacement. No decision yet, no build started.

## crs-board

- [ ] **Dead `npm run link` command.** `worker/scripts/mint-link.mjs` (and its `link` entry in
  `worker/package.json`) POSTs to `/auth/magic-link`, a route that no longer exists — magic-link
  auth was replaced by name+password login before this session. Running it now just fails. Cheap
  cleanup: delete the script and the package.json entry next time you're touching that area.

Otherwise nothing open — recent asks (job notes, the "no work today" banner, New
WO Required's Site/Called-in-by/On-site-contact fields, the hidden Admin login)
all shipped.

## scheduler-investigation (auto-scheduling recommender — prototype, not adopted)

- [ ] **Solver hosting.** CP-SAT can't run inside a Cloudflare Worker — still
  needs a real home before this could ever go live. `autoschedulingdesign.md`
  resolution #6, still open.
- [ ] **Widen the weight-feedback loop's signal.** Only `affinity` (of 8 score
  terms) can currently move — `age`/`type` are structurally job-only and can
  never produce a delta this way; `cont`/`load`/`pref` are zeroed because
  `backtest.py` blank-slates the calendar instead of reconstructing it for real.
  Needs a real historical-calendar reconstruction to unblock those three.
- [ ] **Explain the 21%–74% week-to-week backtest variance.** Flagged, not yet
  investigated.
