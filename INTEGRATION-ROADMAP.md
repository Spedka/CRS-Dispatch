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

## Parked (validated feasible, not built - deliberately paused to expand scope first)

- **"Documentation" window** - cross-references billed invoices against FS `SERVICE_ACK`/
  `TEST_INSPECTION` docs (joined via `OwnerId` = FS Task ExternalId, already linked to the
  Opportunity). Validated 2026-08-20: of 258 billed FS-linked jobs, 243 (94%) have a proof doc,
  224 (87%) marked Complete, only 15 (6%) have none - small, real, actionable gap. Not built -
  user said "keep it in the locker while I expand" to describe the bigger vision first.

## In progress - vision described, not yet built

### Job/Project cost tracking (QBO Projects as the real job-costing container)
Goal: per-Opportunity view of quoted vs. actual cost - what got spent (PO/Bill activity against
that job's QBO Project) alongside what got invoiced (Create Invoice, shipped above) and what FS
says actually happened (hours/completion) - closing the loop the pipeline diagram at the top of
this doc has always described.

**Different in kind from Create PO/Create Invoice, not just another feature in the same
vein.** Checked directly with the user 2026-08-26: QBO Projects have **never really been adopted**
in this org - POs/Bills/Invoices have always mostly gone straight to the parent customer, not
through a Project. Create PO/Create Invoice each replaced a manual data-entry habit that already
existed; this would be the first time Projects get used for their real purpose *at all*. That
would normally be the exact failure mode `PROCESS-ADOPTION.md` warns about - a new discipline
that requires the office to remember to do something differently.

**Why it might actually work anyway:** Create PO already creates a Project automatically the
first time a PO is made for a job, and stamps the crosswalk (`Opportunity.QBO_Project_Id__c`)
with zero extra step from office staff - the Project is a byproduct of a tool they're already
using, not a new habit to adopt. If that holds, real Project-tagged POs start accumulating
without anyone having to be told to do anything new. Worth treating as a real, if unproven,
exception to the usual adoption problem - not a given, since it depends on Create PO itself
staying in regular use.

**Real technical constraint found live 2026-08-26, changes the build shape:** `CustomerRef` (the
Project link) is **not a top-level queryable field** on `PurchaseOrder` or `Bill` -
`SELECT * FROM PurchaseOrder WHERE CustomerRef = 'X'` fails outright
(`QueryValidationError: Property CustomerRef not found for Entity PurchaseOrder`). It only exists
per-line (a single PO/Bill can span multiple Projects). So "every PO/Bill for Project X" can't be
a server-side filter - needs the same pull-then-filter-client-side pattern already used elsewhere
in this app (e.g. `parts.js`'s inventory grouping), not a new pattern.

**Also found live**: one real Opportunity (WO 53515) had a live `QBO_Project_Id__c` pointing at a
Project that's since been deleted in QBO - leftover contamination from Create PO's own build-time
verification testing, not real usage. Flagged to the user for confirmation before clearing it -
a reminder that this crosswalk field needs to tolerate (or periodically reconcile against) a
Project having vanished on the QBO side, not just assume a stored Id is always still valid.

**Not started.** Real, existing QBO Projects (838, most pre-dating this app) do exist to validate
patterns against, but per the "never adopted" finding, don't assume their historical data
represents a clean model to build on - Create PO's own future usage is the real source of truth
going forward.

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
