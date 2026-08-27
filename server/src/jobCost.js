import { Hono } from 'hono';
import { config, statusFieldForType, allStatusFields } from './config.js';
import { createSalesforce } from './salesforce.js';
import { createQbo } from './quickbooks.js';
import { createFs } from './fieldSquared.js';
import { esc, getTechDirectoryAll } from './assignments.js';
import { extractDtbl5Rows, isHelperRow } from './invoices.js';
import { isMaterialFamily, isLaborFamily } from './purchaseOrders.js';

const f = config.fields;
const inv = config.invoicing;

export const jobCost = new Hono();

// Plain float subtraction on real currency values produces visible rounding
// artifacts (e.g. 3303.8599999999997) -- round once here rather than at
// every call site.
const round2 = (n) => Math.round(n * 100) / 100;

// ============================================================================
// "Jobs" filter -- Install/Project-type work, distinct from Service Call,
// Test & Inspection, and Monitoring. Per direction 2026-08-26: RecordType is
// the more concrete signal once populated (a real 'Job' value already exists,
// 22 real records), Opportunity_Type__c is the fallback since it's what's
// actually been populated historically (bare category names like "Fire"/
// "Access"/"CCTV"/"Security" vs. "Service - X"/"Monitoring"/"Test &
// Inspection"). Mirrors the inverse of Create Invoice's isConfirmedServiceJob
// (App.jsx) -- same live-verified fields.
// ============================================================================
export function isJobType(recordType, opportunityType) {
  if (recordType) return recordType === 'Job';
  const t = (opportunityType || '').toLowerCase();
  if (!t) return false;
  if (t.startsWith('service')) return false;
  if (t.includes('monitoring')) return false;
  if (t.includes('inspection')) return false; // "Test & Inspection"
  return true;
}

// Service Call filter -- per direction 2026-08-27, Expense Tracking's list
// broadened from Jobs-only to Jobs + Service Calls that have a real,
// QBO-linked invoice attached (see the invoicedOppIds check in
// GET /finance/expense-jobs below). Mirrors App.jsx's own
// isConfirmedServiceJob exactly, same live-verified fields (RecordType is
// null on nearly every real Opportunity, so Opportunity_Type__c is the
// populated, reliable signal).
export function isServiceType(recordType, opportunityType) {
  if (recordType === 'Service_Call') return true;
  return (opportunityType || '').toLowerCase().startsWith('service');
}

// Real per-tech Item name, e.g. "Wyatt, J.", "Floyd, P. -  Lead" -- confirmed
// live 2026-08-26 this convention appears both with AND without the
// "Fire Alarm -" prefix (a real line came back as bare "Floyd, P.", not
// "Fire Alarm - Floyd, P."), so the prefix alone isn't a reliable enough
// signal on its own -- match the "Lastname, F." shape directly instead.
const TECH_NAME_RE = /\b[a-z]+,\s*[a-z]\./i;

// Best-effort labor/parts/other categorization of a real QBO Invoice's
// SalesItemLineDetail lines -- same convention Create Invoice's own research
// established, now three-way per direction 2026-08-26 (Truck Charges was
// wrongly folded into labor in the first pass -- it's genuinely its own
// thing): per-tech items (with or without a "Fire Alarm -" prefix -- see
// TECH_NAME_RE above), "Helper", and the Install/Project invoice shape's
// lump-sum "Technician" are labor; the lump-sum "Materials" item is parts;
// "Truck Charges", "Shipping:Shipping", "MISC" are other; everything else
// unmatched defaults to parts (a real, unrecognized part SKU is far more
// likely than an unrecognized "other" -- confirmed live: a real part SKU,
// "NOT-BG12LX", would otherwise have wrongly fallen into "other"). Not
// authoritative -- flagged as an estimate in the UI.
function categorizeLine(itemName) {
  const n = (itemName || '').trim();
  const nLower = n.toLowerCase();
  if (nLower === 'helper' || nLower === 'technician' || TECH_NAME_RE.test(n)) return 'labor';
  if (nLower === 'materials') return 'parts';
  if (nLower === 'truck charges' || nLower === 'shipping:shipping' || nLower === 'misc') return 'other';
  return 'parts';
}

// A real Quote's Total_Due__c (or the sum of several) counts as "close to"
// the Awarded Amount within this fraction. Grounded live 2026-08-26 --
// correcting an earlier version of this check that compared against the
// standard Quote.GrandTotal field: GrandTotal never matches Opportunity.
// Amount in this org (it's missing Sales_Tax__c/ShippingHandling2__c/some
// fee lines), while the real custom field Total_Due__c ("Total Due" on the
// real quote template) matches Amount exactly in 11/15 (73%) of real,
// settled single-quote Opportunities sampled. Re-ran the 2+-quote sample
// against Total_Due__c: at 2%, 20/34 resolve via one quote alone and 9/34
// via the sum of every quote on the Opportunity, zero overlap, only 5/34
// (15%) matching neither -- a much stronger signal than GrandTotal ever
// gave, so the tolerance is tightened accordingly (a wider tolerance only
// started pulling in real, deliberate dollar differences -- two real cases
// in the sample were off by an exact $1500 and $900, clearly intentional
// adjustments, not rounding).
const QUOTE_MATCH_TOLERANCE = 0.02;

// Resolve which real Quote(s) represent this Opportunity's award. Order,
// most to least authoritative signal:
//   1. Awarded_Quote__c's prefix match against real Quote.Name values (a
//      real per-record signal when it hits -- direction 2026-08-26).
//   2. Per direction 2026-08-26: a single real Quote whose Total_Due__c is
//      close to the Awarded Amount -- use that one quote alone.
//   3. Per direction 2026-08-26: when no single quote is close but the SUM
//      of every real Quote's Total_Due__c on the Opportunity is close --
//      these are treated as sequential/split quotes covering the whole
//      award together, so all of them are used (their totals get combined
//      by the caller).
//   4. The most recently created Quote for the Opportunity, if any exist.
//   5. No quote data at all.
// Confirmed live: only ~20% of real Opportunities with an Awarded_Quote__c
// value actually have a matching real Quote record at all -- most of the
// time this still falls through past step 1.
async function resolveQuote(sf, oppId, awardedQuoteText, awardedAmount) {
  const quotes = await sf.query(`
    SELECT Id, Name, CreatedDate, Total_Due__c FROM Quote WHERE OpportunityId = '${esc(oppId)}' ORDER BY CreatedDate DESC
  `);
  if (quotes.length === 0) return { quoteIds: [], quoteSource: 'none' };

  if (awardedQuoteText) {
    const parts = awardedQuoteText.split('-');
    if (parts.length >= 2) {
      const prefix = `${parts[0]}-${parts[1]}`.toLowerCase().replace(/\s+/g, '');
      const hits = quotes.filter((q) => (q.Name || '').toLowerCase().replace(/\s+/g, '').startsWith(prefix));
      if (hits.length === 1) return { quoteIds: [hits[0].Id], quoteSource: 'awarded' };
    }
  }

  if (awardedAmount > 0) {
    const closeTo = (n) => Math.abs((n ?? 0) - awardedAmount) <= awardedAmount * QUOTE_MATCH_TOLERANCE;
    const singleMatch = quotes.find((q) => closeTo(q.Total_Due__c));
    if (singleMatch) return { quoteIds: [singleMatch.Id], quoteSource: 'single-match' };
    if (quotes.length > 1) {
      const sum = quotes.reduce((s, q) => s + (q.Total_Due__c ?? 0), 0);
      if (closeTo(sum)) return { quoteIds: quotes.map((q) => q.Id), quoteSource: 'sum-match' };
    }
  }

  return { quoteIds: [quotes[0].Id], quoteSource: 'most-recent' };
}

// ============================================================================
// GET /finance/expense-jobs
// The Expense Tracking tab's list view: every real "Job"-type Opportunity
// (see isJobType above) PLUS every Service Call Opportunity that has at
// least one real, QBO-linked invoice attached (see isServiceType above and
// invoicedOppIds below) -- per direction 2026-08-27, a Service Call with
// nothing billed has nothing to track, but one that's actually been
// invoiced belongs in the same cost view a Job does. Each row's
// materials-spent total comes from the real "CRS Purchase Order" object
// (Opportunity__c) -- one batched aggregate query, not one per row.
// ============================================================================
jobCost.get('/finance/expense-jobs', async (c) => {
  try {
    const sf = createSalesforce(c.env);

    // Per direction: only jobs closed within the past 18 months -- a plain
    // CloseDate bound, no "still open" catch-all. Status is selected via
    // allStatusFields() (every record type's own status field), not just
    // the legacy fallback Project_Status__c -- Service Call resolves its
    // status through Service_Status__c instead (config.recordTypeStatus),
    // and Service Calls are now included in this list (see above).
    const opps = await sf.query(`
      SELECT Id, ${f.oppName}, ${f.oppLid}, Amount, ${f.oppType}, RecordType.DeveloperName,
             ${allStatusFields().join(', ')}, LastModifiedDate,
             ${f.addrStreet}, ${f.addrCity}, ${f.addrState}, ${f.addrZip}, CloseDate
      FROM Opportunity
      WHERE CloseDate >= LAST_N_MONTHS:18
    `);

    // Real, QBO-linked invoices only -- per direction, a plain Invoicing__c
    // row with no real QBO invoice behind it (QBO_Id__c null) doesn't count
    // as "has an invoice attached." A plain, unfiltered-by-job GROUP BY
    // (same "aggregate the whole related table instead of an IN-list"
    // pattern as the PO query below -- an IN-list keyed to hundreds of
    // Opportunity ids blows past GET's URL length limit, confirmed live:
    // "414 URI Too Long") -- checked live 2026-08-27: 39,884 real
    // Invoicing__c rows total, but only 28 distinct jobs have one with a
    // real QBO_Id__c (most invoices in this org still aren't QBO-linked),
    // so the aggregate result here is tiny and the query itself is fast
    // (~250ms) regardless of the base table's size.
    const invRows = await sf.query(`
      SELECT ${inv.job}, COUNT(Id) c FROM ${inv.sobject} WHERE ${inv.job} != null AND ${inv.qboId} != null GROUP BY ${inv.job}
    `);
    const invoicedOppIds = new Set(invRows.map((r) => r[inv.job]));

    const jobs = opps.filter((o) => {
      const recordType = o.RecordType?.DeveloperName ?? null;
      const oppType = o[f.oppType];
      if (isJobType(recordType, oppType)) return true;
      return isServiceType(recordType, oppType) && invoicedOppIds.has(o.Id);
    });
    if (jobs.length === 0) return c.json({ jobs: [] });

    // A plain, unfiltered GROUP BY over the whole Opportunity__c table
    // instead of an IN-list keyed to `jobs` -- that list can run into the
    // hundreds/thousands of real Opportunities within the lookback window,
    // and a SOQL IN-clause that long blows past GET's URL length limit
    // (confirmed live: "414 URI Too Long"). Opportunity__c itself is a small
    // table (2,592 rows all-time, confirmed live) so grouping the whole
    // thing and matching client-side is both simpler and actually cheaper.
    const poRows = await sf.query(`
      SELECT Opportunity_Name__c, SUM(Purchase_Order_Amount__c) total
      FROM Opportunity__c
      WHERE Opportunity_Name__c != null
      GROUP BY Opportunity_Name__c
    `);
    const spentByOppId = new Map(poRows.map((r) => [r.Opportunity_Name__c, r.total ?? 0]));

    const result = jobs.map((o) => {
      const recordType = o.RecordType?.DeveloperName ?? null;
      const address = [o[f.addrStreet], o[f.addrCity], o[f.addrState], o[f.addrZip]].filter(Boolean).join(', ');
      return {
        id: o.Id,
        name: o[f.oppName],
        lid: o[f.oppLid] ?? null,
        address,
        status: o[statusFieldForType(recordType)] ?? null,
        recordType,
        opportunityType: o[f.oppType] ?? null,
        closeDate: o.CloseDate ?? null,
        lastModified: o.LastModifiedDate ?? null,
        awardedAmount: o.Amount ?? 0,
        materialExpenses: spentByOppId.get(o.Id) ?? 0,
        hasPurchaseOrders: spentByOppId.has(o.Id),
      };
    });

    return c.json({ jobs: result });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /finance/job-cost/:oppId
// The Expense Tracking tab's detail view: Awarded Amount, quoted labor/parts
// (from the resolved Quote), Material Expenses (real $, from Opportunity__c),
// labor (Helper/Technician hours only, never a dollar figure -- explicit
// direction, per-tech pay is sensitive), billed vs. remaining-to-bill, and
// the invoice list with a labor/parts/other split and full real line items
// per invoice.
// ============================================================================
jobCost.get('/finance/job-cost/:oppId', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const qbo = createQbo(c.env);
    const fs = createFs(c.env);
    const oppId = c.req.param('oppId');

    const [opp] = await sf.query(`
      SELECT Id, ${f.oppName}, ${f.oppLid}, Amount, ${f.oppFsTaskId}, ${f.oppType}, RecordType.DeveloperName,
             ${f.oppAwardedQuote}
      FROM Opportunity WHERE Id = '${esc(oppId)}' LIMIT 1
    `);
    if (!opp) return c.json({ error: 'Opportunity not found' }, 404);

    const awardedAmount = opp.Amount ?? 0;

    // Material Expenses -- the real "CRS Purchase Order" (Opportunity__c)
    // records themselves, not just the aggregate -- per direction, the
    // Expenses ring's hover popup needs the actual PO-by-PO breakdown.
    const poRecords = await sf.query(`
      SELECT Id, Name, CRS_PO_Number__c, Purchase_Order_Amount__c, CRS_Vendor__r.Name, PO_Sign_Date__c
      FROM Opportunity__c WHERE Opportunity_Name__c = '${esc(oppId)}'
      ORDER BY PO_Sign_Date__c DESC NULLS LAST
    `);
    const materialExpenses = poRecords.reduce((s, r) => s + (r.Purchase_Order_Amount__c ?? 0), 0);
    const materialExpenseLines = poRecords.map((r) => ({
      poNumber: r.CRS_PO_Number__c ?? r.Name,
      vendor: r.CRS_Vendor__r?.Name ?? null,
      amount: r.Purchase_Order_Amount__c ?? 0,
      date: r.PO_Sign_Date__c ?? null,
    }));

    // Quoted Labor / Quoted Parts -- resolve the quote (see resolveQuote's
    // own comment for the real match-rate caveat), then split its lines.
    // Quoted Total / Quoted Labor / Quoted Parts -- read directly from real
    // Quote header fields, per direction 2026-08-26, not re-derived from
    // QuoteLineItem categorization. The earlier line-categorization approach
    // (still used below, but now display-only) silently dropped every real
    // fee/permit/per-diem line from both buckets and never accounted for
    // sales tax or shipping at all -- confirmed live to be the actual root
    // cause of a real reported mismatch, checked against the exact quote in
    // that report (0977-PRE742-00003338) and its real custom fields:
    //   - Total_Due__c ("Total Due") is literally "the total of the quote" --
    //     used directly as Quoted Total, not derived by summing anything.
    //   - TOTAL_MarkupPrice_Discount__c ("TOTAL") minus TOTAL_QLI_Labor__c
    //     ("TOTAL (without Labor)") is Quoted Labor -- SF's own rollup
    //     already isolates the labor lines, so there's no need to guess at
    //     Product2.Family/ProductCode conventions to reconstruct it.
    //   - TOTAL_QLI_Labor__c + Sales_Tax__c + ShippingHandling2__c is Quoted
    //     Parts -- the non-labor line total plus the real tax/shipping
    //     fields, neither of which is a line item at all.
    // Summed across every quote in quoteIds for the 'sum-match' case.
    const { quoteIds, quoteSource } = await resolveQuote(sf, oppId, opp[f.oppAwardedQuote], awardedAmount);
    let quotedLabor = null;
    let quotedParts = null;
    let quotedTotal = null;
    const quotedLaborLines = [];
    const quotedPartsLines = [];
    // Quoted hours, split Helper vs. Technician -- per direction 2026-08-27,
    // to compare against the real logged hours below the same way the
    // dollar rings already compare quoted vs. actual. QuoteLineItem.Quantity
    // on a real hourly labor line IS the quoted hours -- confirmed live
    // 2026-08-27 against a real quote (0977-PRE742-00003338): "Lead"
    // (TECH-155) and "Help" (HELP-95) both carried Quantity=56 at their
    // real hourly UnitPrice, not some unrelated count. Split by the same
    // real TECH-/HELP- ProductCode prefix already used to identify these
    // lines in the first place (isRealLaborLine below), not by name text.
    let quotedHelperHours = null;
    let quotedTechnicianHours = null;
    if (quoteIds.length > 0) {
      quotedHelperHours = 0;
      quotedTechnicianHours = 0;
      // IN (...) rather than one query per quote -- quoteIds is at most a
      // handful (real per-Opportunity Quote counts are small), so this
      // stays a single round trip even in the 'sum-match' multi-quote case.
      const idList = quoteIds.map((id) => `'${esc(id)}'`).join(',');
      const totals = await sf.query(`
        SELECT Id, Total_Due__c, TOTAL_MarkupPrice_Discount__c, TOTAL_QLI_Labor__c, Sales_Tax__c, ShippingHandling2__c
        FROM Quote WHERE Id IN (${idList})
      `);
      quotedTotal = totals.reduce((s, q) => s + (q.Total_Due__c ?? 0), 0);
      quotedLabor = totals.reduce((s, q) => s + ((q.TOTAL_MarkupPrice_Discount__c ?? 0) - (q.TOTAL_QLI_Labor__c ?? 0)), 0);
      quotedParts = totals.reduce((s, q) => s + ((q.TOTAL_QLI_Labor__c ?? 0) + (q.Sales_Tax__c ?? 0) + (q.ShippingHandling2__c ?? 0)), 0);

      // Itemized real QuoteLineItems -- display-only, for the ring hover
      // popovers' line-by-line detail. Not what Quoted Labor/Parts above are
      // computed from anymore (those come straight from the header fields,
      // which include tax/shipping and every real fee/permit/per-diem line
      // that don't map cleanly onto individual "labor" vs. "parts" lines),
      // so these itemized lists may not sum exactly to the figures shown --
      // same real field/Family signal as before for which bucket a line
      // falls into (Labor is NOT just "Family starts with 7000" -- that
      // family is a broad services/fees bucket; genuine field labor also
      // needs the real "TECH-"/"HELP-" ProductCode prefix).
      const isRealLaborLine = (family, code) => isLaborFamily(family) && /^(tech|help)-/i.test((code || '').trim());
      const lines = await sf.query(`
        SELECT Quantity, UnitPrice, Product2.Name, Product2.Family, Product2.ProductCode FROM QuoteLineItem WHERE QuoteId IN (${idList})
      `);
      for (const l of lines) {
        const amt = (l.Quantity ?? 0) * (l.UnitPrice ?? 0);
        const family = l.Product2?.Family;
        const code = l.Product2?.ProductCode;
        const lineOut = { name: l.Product2?.Name ?? null, qty: l.Quantity ?? 0, rate: l.UnitPrice ?? 0, amount: amt };
        if (isRealLaborLine(family, code)) {
          quotedLaborLines.push(lineOut);
          if (/^help-/i.test((code || '').trim())) quotedHelperHours += l.Quantity ?? 0;
          else quotedTechnicianHours += l.Quantity ?? 0;
        } else if (isMaterialFamily(family)) quotedPartsLines.push(lineOut);
      }

      // Reconcile the itemized lists against the real totals shown above --
      // per direction 2026-08-27, don't just leave the gap silently
      // unexplained (the comment above already flagged that tax/shipping/
      // odd-fee lines don't show up in the itemization, but never quantified
      // it). Real tax and shipping (Quote header fields, never line items)
      // get their own synthetic lines with their real values. What's left
      // after that -- confirmed live against JOB 53404 (Quote 00003202) to
      // be dominated by quote-level markup applied to the whole non-labor
      // bucket, not by odd fee lines: materials $5,453.60 + tax $832.18 +
      // shipping $504.35 + markup/other $4,362.88 (73% of the total gap) =
      // $11,423.50, exactly Quoted Parts -- is shown as one "Markup & Other
      // Fees" line so the itemized list actually sums to the figure above
      // it instead of quietly falling short. Same treatment on the labor
      // side for the mirror case (real fee lines in the labor Family that
      // aren't TECH-/HELP- coded, e.g. permits/per diem/plan review, count
      // toward Quoted Labor via the SF header field but never appeared in
      // quotedLaborLines either).
      const partsTax = totals.reduce((s, q) => s + (q.Sales_Tax__c ?? 0), 0);
      const partsShipping = totals.reduce((s, q) => s + (q.ShippingHandling2__c ?? 0), 0);
      const materialLinesSum = quotedPartsLines.reduce((s, l) => s + l.amount, 0);
      const partsRemainder = quotedParts - materialLinesSum - partsTax - partsShipping;
      if (partsTax > 0.005) quotedPartsLines.push({ name: 'Sales Tax', qty: 1, rate: round2(partsTax), amount: round2(partsTax) });
      if (partsShipping > 0.005) quotedPartsLines.push({ name: 'Shipping & Handling', qty: 1, rate: round2(partsShipping), amount: round2(partsShipping) });
      if (Math.abs(partsRemainder) > 0.005) quotedPartsLines.push({ name: 'Markup & Other Fees', qty: 1, rate: round2(partsRemainder), amount: round2(partsRemainder) });

      const laborLinesSum = quotedLaborLines.reduce((s, l) => s + l.amount, 0);
      const laborRemainder = quotedLabor - laborLinesSum;
      if (Math.abs(laborRemainder) > 0.005) quotedLaborLines.push({ name: 'Permits, Fees & Other Labor Charges', qty: 1, rate: round2(laborRemainder), amount: round2(laborRemainder) });
    }

    // Labor hours, split Helper vs. Technician -- every real (non-empty)
    // SERVICE_ACK doc for this job, summed across ALL visits (a total,
    // unlike Create Invoice's per-doc picker). Gracefully empty when there's
    // no FS link at all, or (found live 2026-08-26) when the linked FS task
    // no longer resolves there (fs.getTask throws on a 404 rather than
    // returning a not-ok response) -- best-effort, same as the QBO invoice
    // pull below, so a stale/broken FS link degrades to empty hours instead
    // of 500ing the whole detail view.
    //
    // Per-tech breakdown (who/how many, per direction 2026-08-27) -- resolved
    // via getTechDirectoryAll (assignments.js), NOT the active-only
    // getTechDirectory Create Invoice/live scheduling use -- confirmed live
    // 2026-08-27: a real technician (Adrian Van Luven) had real hours
    // correctly logged under his real FS_User_Id__c, but is now Active__c =
    // false (left since doing the work), so the active-only directory
    // showed him as an unresolved raw id. Historical hours shouldn't
    // disappear just because someone's no longer active. Still hours only,
    // never a dollar figure -- this doesn't touch the per-tech-pay privacy
    // constraint at all, it's the same total just disaggregated by person
    // instead of collapsed into one number. A tech with no Technician__c
    // record at all (not just inactive -- genuinely absent) falls back to
    // the raw FS user id, same convention invoices.js already uses, rather
    // than being silently dropped.
    let helperHours = 0;
    let technicianHours = 0;
    let hasFsData = false;
    const helperByTech = new Map();
    const technicianByTech = new Map();
    if (opp[f.oppFsTaskId]) {
      try {
        const techDir = await getTechDirectoryAll(sf);
        const task = await fs.getTask(opp[f.oppFsTaskId]);
        const docIds = task.Documents || (task.Docs || []).map((d) => d.ObjectId) || [];
        for (const docId of docIds) {
          const r = await fs.getDocument(docId);
          if (!r.ok) continue;
          let doc;
          try { doc = JSON.parse(r.body); } catch { continue; }
          const rows = extractDtbl5Rows(doc);
          if (rows.length === 0) continue;
          hasFsData = true;
          for (const row of rows) {
            const techName = techDir.byFsId[row.fsUserId]?.name || row.fsUserId;
            const byTech = isHelperRow(row) ? helperByTech : technicianByTech;
            byTech.set(techName, (byTech.get(techName) ?? 0) + row.hours);
            if (isHelperRow(row)) helperHours += row.hours;
            else technicianHours += row.hours;
          }
        }
      } catch {
        // Best-effort -- leave hours at 0 / hasFsData false if the FS pull fails.
      }
    }

    // Invoices -- every real Invoicing__c record for this job, with a
    // labor/parts/other split and the full real line list pulled from the
    // real QBO Invoice (via QBO_Id__c) when available.
    const invoiceRows = await sf.query(`
      SELECT Id, Name, ${inv.date}, ${inv.amount}, ${inv.status}, ${inv.qboId}
      FROM ${inv.sobject} WHERE ${inv.job} = '${esc(oppId)}'
      ORDER BY ${inv.date} DESC NULLS LAST
    `);
    const invoices = [];
    let billedLabor = 0;
    let billedMaterials = 0;
    let billed = 0;
    for (const r of invoiceRows) {
      billed += r[inv.amount] ?? 0;
      const qboId = r[inv.qboId];
      const base = {
        id: r.Id,
        date: r[inv.date] ?? null,
        amount: r[inv.amount] ?? null,
        status: r[inv.status] ?? null,
        qboId: qboId || null,
        // The real invoice/doc number ("7849879-ML" style) IS Invoicing__c's
        // own Name field -- entered directly on the SF record, independent
        // of QBO_Id__c. Confirmed live 2026-08-27 (JOB 53404): this record's
        // QBO_Id__c is still null (not yet backfilled), but its Name is
        // already the real doc number. Per direction, show it whether or
        // not the QBO link exists -- don't gate it behind a live QBO fetch
        // that only succeeds once QBO_Id__c is populated. The live fetch
        // below (when qboId IS set) can still refine/confirm it from the
        // real QBO Invoice, but Name is the primary source now, not a
        // last-resort fallback.
        docNumber: r.Name ?? null,
        laborAmt: null,
        partsAmt: null,
        otherAmt: null,
        lines: [],
      };
      if (qboId) {
        try {
          const qr = await qbo.query(`SELECT * FROM Invoice WHERE Id = '${qboId}'`);
          const qboInvoice = (qr.Invoice || [])[0];
          if (qboInvoice) {
            // Prefer the live QBO DocNumber when present (the real source of
            // truth once linked), but don't clobber the SF Name-derived
            // value above with null if this particular QBO record happens
            // not to carry one.
            base.docNumber = qboInvoice.DocNumber ?? base.docNumber;
            let laborAmt = 0;
            let partsAmt = 0;
            let otherAmt = 0;
            const lines = [];
            for (const l of qboInvoice.Line || []) {
              if (l.DetailType !== 'SalesItemLineDetail') continue;
              const sd = l.SalesItemLineDetail;
              const name = sd?.ItemRef?.name;
              const amt = l.Amount || 0;
              const category = categorizeLine(name);
              if (category === 'labor') laborAmt += amt;
              else if (category === 'parts') partsAmt += amt;
              else otherAmt += amt;
              lines.push({ itemName: name ?? null, qty: sd?.Qty ?? null, rate: sd?.UnitPrice ?? null, amount: amt, category });
            }
            base.laborAmt = laborAmt;
            base.partsAmt = partsAmt;
            base.otherAmt = otherAmt;
            base.lines = lines;
            billedLabor += laborAmt;
            billedMaterials += partsAmt;
          }
        } catch {
          // Best-effort -- leave the split/lines empty if the QBO pull fails.
        }
      }
      invoices.push(base);
    }

    const remainingToBill = round2(Math.max(0, awardedAmount - billed));
    const overBilledBy = billed > awardedAmount ? round2(billed - awardedAmount) : null;

    return c.json({
      opportunity: { id: opp.Id, name: opp[f.oppName], lid: opp[f.oppLid] ?? null },
      awardedAmount,
      quotedLabor: quotedLabor != null ? round2(quotedLabor) : null,
      quotedParts: quotedParts != null ? round2(quotedParts) : null,
      quotedTotal: quotedTotal != null ? round2(quotedTotal) : null,
      quotedLaborLines,
      quotedPartsLines,
      quoteSource,
      materialExpenses,
      materialExpenseLines,
      hasPurchaseOrders: poRecords.length > 0,
      billedLabor: round2(billedLabor),
      billedMaterials: round2(billedMaterials),
      helperHours,
      technicianHours,
      helperBreakdown: [...helperByTech.entries()].map(([name, hours]) => ({ name, hours })).sort((a, b) => b.hours - a.hours),
      technicianBreakdown: [...technicianByTech.entries()].map(([name, hours]) => ({ name, hours })).sort((a, b) => b.hours - a.hours),
      quotedHelperHours,
      quotedTechnicianHours,
      hasFsData,
      hasFsLink: !!opp[f.oppFsTaskId],
      billed: round2(billed),
      remainingToBill,
      overBilledBy,
      invoices,
    });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
