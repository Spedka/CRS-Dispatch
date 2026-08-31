# Integration Roadmap - QBO ↔ SF ↔ FS ↔ Vendors

A living doc tracking the technical vision: **a full pipeline per Opportunity** - work gets
dispatched, done, documented, billed, and paid, with each stage visible and (eventually)
verifiable against the ones before and after it. This is the "one-stop-shop for daily office
tasks" goal. See [`PROCESS-ADOPTION.md`](PROCESS-ADOPTION.md) for the separate, equally
important question of whether any of this actually gets *used* once built - half of what's
below is worthless without that answer, so read both.

_Started 2026-08-20, split out of PROCESS-ADOPTION.md once the technical scope outgrew it._

## The pipeline, end to end (target state)

```
Opportunity → FS work order (linked) → FS documents (proof of work: SERVICE_ACK / TEST_INSPECTION)
   → SF Invoicing__c (billed) → QBO invoice (sent) → payment received
   → vendor PO / actual material cost tied back in → real margin per job
```

Every arrow above is a place where the two sides can silently disagree or go missing - that's
the recurring shape of everything on this list.

## Shipped

- **FS ↔ SF work order linking** (tier-3 LID matching for T&I, cron freshness/priority fixes,
  no-skip-fresh, uniqueness gates). Deployed. See crs-dispatch `CLAUDE.md` "Matching logic".
- **QBO ↔ SF billing reconciliation** (`/finance/reconciliation`, admin "Billing" tab). Deployed
  2026-08-21. Covers:
  - SF vs QBO billed/received totals (QBO billed = sent invoices only, `EmailStatus=EmailSent`)
  - Per-invoice cross-reference: matched / QBO-only / SF-only, date-range + group-by (SF/QBO
    account & parent) + payment-method filter, duplicate-invoice-number pairing by nearest
    amount, invoice date column, collapsible sections, per-section invoice-# filter.
- **Create PO** (Parts tab → "+ Create PO") - accurate per-job material cost, for invoice
  drafting *and* margin visibility, eventually. Deployed 2026-08-21, then hardened through
  several real-usage bug-fix rounds through 2026-08-24 (see below) once actually used against a
  real job (WO 53515).

  **The "free byproduct" bet didn't hold** - checked live 2026-08-21. QBO `PurchaseOrder` has
  `LID #`/`Job/WO#` custom fields provisioned for exactly this, but they're filled on ~5 of 1,510
  records. `Bill` line items do carry real job-tagging via `CustomerRef`, but only from 2017–2019
  ($150K of $909K all-time, ~$0 since 2020); `Purchase` (the entity that actually carries CRS's
  current-day vendor spend) is tagged on 2.3% of lines, mostly noise. So there's no passive read
  that gets this for free going forward.

  **What ships instead**: makes the real, still-used QBO mechanism - the per-line `CustomerRef`
  pointing at a "Project" (a `Job:true` sub-Customer; 838 exist, 73% of all POs already use one)
  - automatic instead of manual:
  - Multi-select the Opportunity/ies a PO covers (a PO can legitimately span several jobs); for
    each, pick which Salesforce `Quote` to source lines from (or enter lines manually - confirmed
    live, `Awarded_Quote__c` is a display string, not a working lookup, and 40% of jobs have no
    linked `Quote` at all).
  - Pools quote lines across all selected jobs, grouped by vendor (a QBO PO is single-vendor);
    quantity/description prefill from the quote, cost is always a fresh manual entry
    (`QuoteLineItem.UnitPrice` is the customer sale price, not vendor cost).
  - Resolves a QBO Project per job - reusing a stored crosswalk (`Opportunity.QBO_Project_Id__c`,
    new field) if one exists, else a suggested-but-confirmed existing Project or a newly-created
    one - and writes that crosswalk back so the next PO against the same job is instant, no
    re-matching.
  - Live-verified end-to-end (test records created and cleaned up): correct `VendorRef`,
    per-line `CustomerRef`/Project, `APAccountRef` (required - not defaulted, found live),
    `AccountBasedExpenseLineDetail` with the `Materials` account (QBO's `Item` catalog here isn't
    account-mapped, so `ItemBasedExpenseLineDetail` gets rejected - found live), and the SF
    crosswalk write-back/reuse.
  - Server: `server/src/purchaseOrders.js` (new routes), `server/src/quickbooks.js` (`create()`
    write method added - was read-only). No role gate, same as Add Inventory/Part Checkout.
  - Not yet wired to `Available_Inventory__c.PO_Number__c` - that stays a separate manual step
    when parts physically arrive, same as today.

  **Real-usage fixes, 2026-08-24** (found via the first actual job run, WO 53515, not by more
  read-only investigation):
  - Item matching was silently hiding real material - filtering PO-eligible quote lines by
    `Product2.Vendor__c` was wrong (only ~54% of lines carry one; a real 17-line quote showed
    only 2). Switched to excluding by `Product2.Family` (`7000 - Labor`/`8000 - Other`) instead,
    which is the actual reliable signal.
  - Line descriptions were being hand-concatenated (`code - name`) instead of pulled from a real
    field - fixed to use the matched QBO Item's own `Description`, or Salesforce `Product2.Name`
    as a fallback. `Product2.Description` itself turned out to be repurposed in this org for
    brand/vendor tags ("AMAG", "Schlage", "INACTIVE"), not real descriptive text - not used at all
    now.
  - Unmatched parts now get created as real QBO Product/Service Items (prefilled from Salesforce,
    editable) instead of falling back to a generic Materials-account line.
  - Found and fixed a field-conflation bug in that create-item form: a single ambiguous
    "name/SKU" input could silently diverge from what actually got sent to QBO. Now one clear
    "SKU / part #" field drives both `Name` and `Sku` identically.
  - Added `Product2.StockKeepingUnit` as a second, higher-priority SKU source (distinct from
    `ProductCode` - confirmed live they can genuinely differ, e.g. `ProductCode` "Hard Drive" vs.
    the real SKU "WD62PURZ") for both matching and the create-item prefill. Only populated on
    ~2% of active products today, but correct when it is.
  - PO number now auto-generates (`YY-####`, matching the real human-entered scheme) - this
    company has QBO's "Custom Transaction Numbers" preference on, so the API was leaving it
    blank previously.
  - `APAccountRef` turned out to be required on create (not defaulted, despite docs implying
    otherwise); the "Parts" fallback Item turned out to be a bare `Category` with no account,
    rejected outright - both found only by attempting a real create.
  - Flow reordered: Project resolution (existing vs. create-new) now happens *before* line/cost
    entry, per direction, so the line screen is nothing but rates to fill in by the time you
    reach it, and creating a missing Project leads with a "doesn't exist yet - create it?" prompt
    instead of a neutral existing-vs-new toggle.
  - Also fixed, unrelated to Create PO but found via the same testing session: a real dropdown
    bug in the shared `SearchableSelect` component (used by Create PO, Add Assignment, Add
    Inventory, Part Checkout) - a window-level capture-phase `scroll` listener meant to close the
    dropdown when an ancestor container scrolled was also catching the browser's own internal
    text-scroll event once typed/pasted text overflowed the input's visible width, closing the
    dropdown instantly. Three native `<select>` elements (the schedule tab's technician filter,
    Add Time Off's technician picker, and every Opportunity-tab status select) were also swapped
    for the app's own styled `FilterSelect`, since a real `<select>`'s open list can never be
    themed with CSS.

- **Create Invoice** (Outstanding Jobs → every `JobCard`, and Accounts → Ready to Bill →
  `JobInvoiceRow`) - drafts a QBO invoice from a real FS `SERVICE_ACK` doc instead of retyping it,
  office reviews and sends. Built and live-verified 2026-08-25 against a real already-sent
  invoice (`7849883`, WO 53158) - the drafted lines matched the real invoice's own defaults
  almost exactly (customer, anchor line, narrative, rates, $2,180 total), after several
  corrections found only by testing against that ground truth rather than trusting the first
  design pass:
  - Real per-employee QBO labor Items exist (`Fire Alarm - Lastname, F.`), but which tech gets
    billed under their own item vs. generic `Helper` is decided by that `DTBL5` row's `REP_TYPE`
    (`Installer` vs. `Helper`), not tech identity - a real tech with their own catalog item still
    gets billed as `Helper` when their `REP_TYPE` says so. Overturned an earlier (single-tech-only)
    conclusion that `REP_TYPE` doesn't matter.
  - Visit grouping is by distinct calendar date in `DTBL5[].TIME_IN`, not row count - multiple
    techs on the same date share one narrative note and one `Truck Charges` line. The top-level
    `DATE`/`DATE_COMPLETED` fields are confirmed unreliable (found reversed on a real doc) and
    never used for this.
  - Every line's rate comes from the matched QBO Item's own `UnitPrice` - FS's own recorded price
    (`EQUIPMENT_MATERIALS[].CAT.PRICE`) is unused and can be wildly wrong (a real part's FS price
    was $45.75 vs. the $197.16 actually billed).
  - Tax code is derived from a plain `Taxable` boolean on the Item - there's no `SalesTaxCodeRef`
    field on these Items at all, despite that being the more obvious-looking field name.
  - The `Account → QBO Customer` billing crosswalk can't be a single stored value the way
    `QBO_Project_Id__c` is for Create PO - Accounts are often named after the property/building,
    not the payer (one real Account spanned ~20 different real tenant AR codes across its job
    history), so a single "correct" customer per Account is sometimes just wrong. Ships instead as
    a ranked frequency suggestion (`Invoicing__c.QBO_Customer_Id__c`, stamped on every invoice
    created here) - most useful on single-tenant Accounts where one name dominates, still honest
    on multi-tenant ones.
  - The "confirmed Service job" caution-banner gate had to be `Opportunity_Type__c`-based, not
    `RecordType` - ~44,000 of ~45,000 real Opportunities have no `RecordType` at all (the 2026-08
    restructure applies forward only), so gating on it would fire on virtually every real job.
  - `fs.getTask(FS_Task_Id__c).Documents` is the real, scalable way to enumerate a job's FS docs -
    there's no server-side `ownerid` filter on FS's `/api/document` endpoint (confirmed live: it
    silently ignores the param and returns its full 12,679-doc/18MB corpus).
  - Server: `server/src/invoices.js` (new routes), `server/src/qboShared.js` (factored out of
    `purchaseOrders.js` - `matchItem`/`getUsableItems` shared, plus new `matchTechItem`,
    `getSalesItems`). Found and fixed a real latent bug in the shared item cache while building
    this: `getUsableItems()`'s `ExpenseAccountRef` filter (correct for PO purchase lines) was
    silently excluding every real labor/sales Item, which only carry `IncomeAccountRef` - split
    into a separate `getSalesItems()` for invoice lines.
  - Also added: a non-blocking cross-check against this app's own `Job_Assignment__c` records
    (who was actually dispatched here) vs. what the FS doc's techs/dates say - flags disagreement,
    never blocks.
  - No role gate, same convention as Create PO.

- **Job/Project cost tracking** (Expense Tracking admin tab, `server/src/jobCost.js`) - deployed
  2026-08-27 (commit `1cbc85b`). This is the "In progress" item described lower in this doc as of
  2026-08-26, shipped the very next day - **but via a different technical approach than the one
  sketched below**, worth noting since the plan section under "Parked/In progress" is now stale on
  the *how*, even though the *what* (per-Opportunity quoted vs. actual cost) matches:
  - The "real technical constraint" noted below (`CustomerRef` not a top-level queryable field on
    `PurchaseOrder`/`Bill`, so per-Project spend can't be a server-side QBO filter) turned out
    moot - material expense per job reads from this app's **own** `Opportunity__c` ("CRS Purchase
    Order") mirror records (the SF write-back Create PO already does on every PO it creates), not
    a live QBO query filtered by `QBO_Project_Id__c` at all. Sidesteps the constraint entirely
    rather than solving it.
  - Quoted labor/parts/total read straight from real Quote header fields
    (`Total_Due__c`/`TOTAL_QLI_Labor__c`/`Sales_Tax__c`/`ShippingHandling2__c`), not summed from
    QuoteLineItems - an earlier line-summing approach silently dropped fee/permit/tax/shipping
    lines, traced to a real reported mismatch on a specific quote.
  - Billed labor/parts/other is read live from real QBO Invoice lines (categorized by item-name
    heuristic), not from the SF `Invoicing__c` mirror.
  - FS-logged tech hours come from `SERVICE_ACK` documents (reusing `invoices.js`'s own
    `DTBL5`-row parsing), same source Create Invoice already reads.
  - Service Call material cost (almost never has a real PO on file, confirmed live) is
    *estimated* from Product2 Standard Pricebook list price instead of read as $0.
  - Per-tech pay is deliberately hours-only, never dollars - "per-tech pay is sensitive," per
    direction.
  - Also shipped the same week: **Billing Reconciliation** (admin "Billing" tab,
    `/finance/reconciliation`) - already described as shipped 2026-08-21 above; both share the
    same `quickbooks.js` client.

- **Create PO — Service Call / Service Stock paths** (`server/src/materialReqs.js`, extended
  `purchaseOrders.js`, `CreatePOPathPicker`/`CreatePOMaterialReqModal` in App.jsx) - deployed
  2026-08-31. Extends the original Job-only Create PO (above) into a 3-way picker shown before any
  wizard starts, reachable from the Parts tab and from a service call's own row in Outstanding
  Jobs (a `+ PO` quick-action next to the existing `+ Invoice` one):
  - **Service Call** - sources lines from that one service call's real Field Squared
    `MATERIAL_REQ` document(s) instead of a Quote (confirmed live 2026-08-31: a genuine, separate
    structured FS document type, `Data.DTBL34` line items - structurally almost identical to
    `SERVICE_ACK`'s own material rows). Billed to a real top-level QBO Customer (not a Project),
    suggested via the same suggest-from-invoice-history logic Create Invoice already uses -
    "this part is for this service and only this service," per direction.
  - **Service Stock** - pools `MATERIAL_REQ` docs from any number of different service calls into
    one PO, always billed to the fixed Service Stock Opportunity's own QBO Project - safe to pool
    across sources specifically because every line resolves to the same destination regardless of
    which service call it came from, unlike a genuine multi-customer PO. No hard gate: a Service
    Stock PO can be made with zero source service calls at all (proactive restocking ahead of
    unplanned work is a real, expected case, not just a fallback). The QBO Project crosswalk on
    the Service Stock Opportunity started out blank (Service Stock had never gone through a real
    PO before this feature) - resolved via a one-time env-var fallback
    (`SERVICE_STOCK_QBO_CUSTOMER_ID`) that self-heals onto the real Salesforce field the first
    time a Service Stock PO is actually created, same write-back mechanism the Job path already
    used.
  - This is `INTEGRATION-ROADMAP.md`'s own "Material requests - same pattern as POs" open question
    from `PROCESS-ADOPTION.md` #2, now substantially answered on the tooling side: material reqs
    turned out to be real, structured, FS-native data, not a PDF-only dead end - see
    `parts-warehouse.md`'s superseded assumption, corrected in `CLAUDE.md`.

## Parked (validated feasible, not built - deliberately paused to expand scope first)

- **"Documentation" window** - cross-references billed invoices against FS `SERVICE_ACK`/
  `TEST_INSPECTION` docs (joined via `OwnerId` = FS Task ExternalId, already linked to the
  Opportunity). Validated 2026-08-20: of 258 billed FS-linked jobs, 243 (94%) have a proof doc,
  224 (87%) marked Complete, only 15 (6%) have none - small, real, actionable gap. Not built -
  user said "keep it in the locker while I expand" to describe the bigger vision first.

## In progress - vision described, not yet built

### Job/Project cost tracking - SHIPPED 2026-08-27, see "Shipped" above
The planning below (2026-08-26) is kept for its still-relevant technical findings, but the
actual build (`jobCost.js`/Expense Tracking, "Shipped" section above) **sidestepped the
QBO-Projects approach entirely** rather than solving the constraint it identified - worth reading
if a *live* QBO-Project-filtered PO/Bill view is ever wanted for something else:

- Checked 2026-08-26: QBO Projects have **never really been adopted** in this org - POs/Bills/
  Invoices have always mostly gone straight to the parent customer, not through a Project. Making
  Job cost tracking depend on Project data at all would've been the exact new-discipline failure
  mode `PROCESS-ADOPTION.md` warns about.
- **Real technical constraint, still true**: `CustomerRef` (the Project link) is **not a
  top-level queryable field** on `PurchaseOrder` or `Bill` -
  `SELECT * FROM PurchaseOrder WHERE CustomerRef = 'X'` fails outright
  (`QueryValidationError: Property CustomerRef not found for Entity PurchaseOrder`). It only
  exists per-line, so "every PO/Bill for Project X" can never be a server-side QBO filter -
  would need the same pull-then-filter-client-side pattern used elsewhere in this app.
- One real Opportunity (WO 53515) was found with a live `QBO_Project_Id__c` pointing at a
  since-deleted QBO Project - leftover from Create PO's own build-time testing. A reminder the
  crosswalk field needs to tolerate a Project having vanished on the QBO side, not assume a
  stored Id is always still valid.
- What shipped instead reads material expense from this app's own `Opportunity__c` ("CRS
  Purchase Order") mirror records - the SF write-back Create PO already does on every PO - never
  a live QBO Project query at all. See the "Shipped" entry above for the real build.

### Vendor price sync (ADI, Potter, others) - IN PROGRESS, blocked on ADI
Goal: keep `Product2`/`PricebookEntry` pricing (and, per the Create PO fixes above,
`Product2.StockKeepingUnit` - the real manufacturer SKU) current with vendor catalogs. Real
vendor breakdown, confirmed live 2026-08-24 (active `Product2` rows with `Vendor__c` set): ADI
487, Notifier 154, Identiv 30, SAF 21, JLM 16, Bosch 5, Anixter 4, FCI/Kele/Cable Plus 1 each.
ADI alone is ~64% of tagged catalog - the one integration worth having.

**Researched 2026-08-24, more promising than the 2026-08-20 "reality check" assumed:** ADI does
have a real, established data-integration surface - confirmed via three known B2B platforms
(VARStreet, Simpro, D-Tools) that already pull ADI's live catalog + customer-specific pricing via
a prebuilt real-time XML feed, FTP-distributed. Potter is sold *through* ADI (their own catalog
lists Potter as a carried supplier line), so one ADI integration likely covers Potter too without
a second one; worth confirming with the rep whether Notifier (also commonly distributed via ADI)
is covered the same way, which could mean one relationship covers most of the tagged catalog.

**Evaluated and rejected: XTEN-AV, ConnectWise CPQ, D-Tools SI** (all three are ADI's own listed
software-integration partners) as a shortcut to that feed. All three are whole paid business
platforms ($50-150+/user/month) where "talks to ADI" is a bundled feature, not a lightweight
pricing utility - AV design (XTEN-AV), generic IT/MSP quoting (ConnectWise), or full
integrator/procurement management (D-Tools, the only one of the three with a genuinely
documented outbound API). Adopting any of them would mean a new recurring cost and a tool whose
core job (quoting/project management) already substantially overlaps with Salesforce/crs-dispatch
- the same "another system nobody actually uses" risk `PROCESS-ADOPTION.md` already diagnosed
elsewhere. Not recommended unless CRS wants one of these platforms for independent reasons.

**No self-serve API exists** - access is arranged through ADI directly (their software-
integrations team or account rep), not a public developer portal.

**Current step, 2026-08-24: user is contacting ADI support** to request electronic catalog access
for fire parts (their real ADI portal login already exists - first checking whether it offers a
bulk price-list export before pursuing a formal XML/FTP feed request). **Next, once ADI
responds:** get a real sample export/feed, confirm whether it carries real manufacturer SKUs
(would directly close the `StockKeepingUnit` gap from the Create PO fixes above), then build the
actual importer (`Product2`/`PricebookEntry` update, keyed off whatever real code the feed uses).

## Open questions across this whole roadmap
- Once invoice drafting is built, does the "Documentation" window become a pre-check *before*
  drafting (don't offer to draft an invoice with no proof doc) rather than a separate report?
- Full end-to-end pipeline visibility (the diagram at the top) implies a per-Opportunity view
  showing every stage's status at once - not designed yet; may fall out naturally once the
  individual pieces above exist, or may need its own screen.

## Related
- [`PROCESS-ADOPTION.md`](PROCESS-ADOPTION.md) - why built things don't get used; read before
  assuming any of the above will matter once shipped.
- `CLAUDE.md` - technical architecture reference for what's already shipped.
