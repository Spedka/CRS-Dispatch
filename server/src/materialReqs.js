import { Hono } from 'hono';
import { config } from './config.js';
import { createSalesforce } from './salesforce.js';
import { createFs } from './fieldSquared.js';
import { esc } from './assignments.js';
import { getUsableItems, matchItem } from './qboShared.js';
import { suggestCustomersForAccount } from './invoices.js';

const f = config.fields;

export const materialReqs = new Hono();

// Field Squared material requisition -- the parallel doc type to SERVICE_ACK
// for parts a tech needs (as opposed to what they did/how long). Confirmed
// live 2026-08-31 against a real doc (ExternalId eqvUIIgL4qB-O6b-GME1ggAAgg,
// created via a dedicated FS form): Type is literally 'MATERIAL_REQ', not
// something this app previously knew about -- an earlier note in
// parts-warehouse.md describing "PDF only, no structured data" turned out to
// describe a different, older Salesforce-side mechanism
// (Part_Checkout__c.Material_Request_Number__c), not this FS form.
//
// Structurally almost identical to SERVICE_ACK's own EQUIPMENT_MATERIALS:
// line items live in a 50-slot padded array, Data.DTBL34 (same padding
// convention as DTBL5/EQUIPMENT_MATERIALS -- a doc commonly has dozens of
// empty {} placeholder slots alongside 1-few real ones), with real row shape
//   { PART_NUM, DESC, QTY, CAT: { PROD_CODE, PROD_NAME, PRICE, ... },
//     TAKEN_FROM, PO_NUM, PERCENTCOMPLETE }
// CAT.PRICE is a currency-formatted string ("$72.99") -- same rule as
// invoices.js's parts lines applies here too: NEVER used for actual cost,
// only PART_NUM/CAT.PROD_CODE for matching which QBO Item. TAKEN_FROM
// ("Counter Pick up"/"CRS Stock") and PO_NUM (a PO # the tech already has,
// e.g. from calling a vendor directly) have no SERVICE_ACK equivalent --
// both optional, surfaced for the office but never required.
const MATERIAL_REQ_TYPE = 'MATERIAL_REQ';

// Real, non-empty material-req line rows only -- like extractMaterials()
// (invoices.js) for EQUIPMENT_MATERIALS, filters out the padding.
function extractMaterialReqLines(doc) {
  return (doc?.Data?.DTBL34 || []).filter((m) => m && (m.PART_NUM || m.CAT?.PROD_CODE || m.DESC));
}

// GET /finance/service-call-opportunities
// The opportunity picker behind the Service Call / Service Stock PO paths
// (App.jsx's CreatePOMaterialReqModal) needs a broader universe than the
// dispatch board's own GET /jobs list. That query is deliberately scoped to
// "currently outstanding" statuses (config.recordTypeStatus.valuesByType,
// boardStatusPredicate) plus a recency window on the base branch -- correct
// for a scheduling board, but wrong here: a material req (and the PO built
// from it) is routinely created well AFTER a service call has finished and
// moved on to a closed-out/invoiced status past that list, which is exactly
// when this bug was found live 2026-08-31 (searching a real, already-serviced
// call in the picker came back "no matches" -- it had simply scrolled off the
// board). Mirrors jobCost.js's GET /finance/expense-jobs, which hit the same
// problem for the same reason and solved it the same way: no status filter
// at all, just a plain CloseDate recency bound. RecordType is null on most
// real Opportunities (see isServiceType's own note, jobCost.js) --
// Opportunity_Type__c is the fallback signal for those, matched the same way
// isServiceType does (LIKE 'Service%').
materialReqs.get('/finance/service-call-opportunities', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const opps = await sf.query(`
      SELECT Id, ${f.oppName}, ${f.oppLid}
      FROM Opportunity
      WHERE (RecordType.DeveloperName = 'Service_Call'
             OR (RecordType.DeveloperName = null AND ${f.oppType} LIKE 'Service%'))
        AND CloseDate >= LAST_N_MONTHS:18
      ORDER BY CloseDate DESC
    `);
    return c.json(opps.map((o) => ({ id: o.Id, name: o[f.oppName], lid: o[f.oppLid] ?? null })));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /finance/material-reqs/:oppId
// Mirrors invoices.js's GET /finance/service-acks/:oppId exactly -- same
// Opportunity -> FS_Task_Id__c -> fs.getTask().Documents -> per-doc fetch
// path. This is the only scalable way to enumerate a job's FS documents --
// /api/document has no usable server-side filter (confirmed live in
// invoices.js already: ?type= returns a hard 400 "Filters required" on every
// value tried, and an unfiltered call returns the org's full ~12.7k-doc/18MB
// corpus). fs.getTask() throws on a stale/missing link -- degrade to an
// empty list rather than 500, same as jobCost.js's own SERVICE_ACK lookup.
materialReqs.get('/finance/material-reqs/:oppId', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const fs = createFs(c.env);
    const oppId = c.req.param('oppId');

    const [opp] = await sf.query(`
      SELECT Id, ${f.oppFsTaskId} FROM Opportunity WHERE Id = '${esc(oppId)}' LIMIT 1
    `);
    if (!opp) return c.json({ error: 'Opportunity not found' }, 404);
    const fsTaskId = opp[f.oppFsTaskId];
    if (!fsTaskId) return c.json({ docs: [] });

    let task;
    try {
      task = await fs.getTask(fsTaskId);
    } catch {
      return c.json({ docs: [] }); // stale/missing FS link -- not an error
    }
    const docIds = task.Documents || (task.Docs || []).map((d) => d.ObjectId) || [];

    const docs = [];
    for (const docId of docIds) {
      const r = await fs.getDocument(docId);
      if (!r.ok) continue;
      let doc;
      try { doc = JSON.parse(r.body); } catch { continue; }
      if (doc.Type !== MATERIAL_REQ_TYPE) continue;
      const lines = extractMaterialReqLines(doc);
      if (lines.length === 0) continue; // empty draft
      docs.push({
        docId,
        created: doc.Created,
        tech: doc.Data?.TECH ?? null,
        jobName: doc.Data?.JOB_NAME ?? null,
        jobWoNum: doc.Data?.JOB_WO_NUM ?? null,
        lineCount: lines.length,
      });
    }
    return c.json({ docs });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /finance/material-reqs/:oppId/:docId/lines
// Returns the SAME flat shape as GET /finance/quotes/:quoteId/lines
// (purchaseOrders.js) -- {code, name, vendor, quantity, itemId, itemName,
// description} -- so the frontend's existing line-pooling logic treats a
// material-req line identically to a quote line, no branching needed.
// `vendor` is always null here (unlike quote lines, there's no Product2
// lookup to pull Vendor__c from -- FS just doesn't carry that signal) --
// the frontend's vendor-suggestion step already degrades gracefully when no
// pooled line has a vendor hint. `takenFrom`/`existingPoNum` are extra
// fields beyond the shared shape, safe for a caller that doesn't know about
// them to ignore.
materialReqs.get('/finance/material-reqs/:oppId/:docId/lines', async (c) => {
  try {
    const fs = createFs(c.env);
    const docId = c.req.param('docId');

    const [docRes, items] = await Promise.all([
      fs.getDocument(docId),
      getUsableItems(c.env), // purchase-side items (ExpenseAccountRef) -- these are PO lines, not invoice lines
    ]);
    if (!docRes.ok) return c.json({ error: 'Could not load that document from Field Squared' }, 502);
    const doc = JSON.parse(docRes.body);
    const rawLines = extractMaterialReqLines(doc);
    if (rawLines.length === 0) return c.json({ error: 'This material req has no lines' }, 400);

    const lines = rawLines.map((m) => {
      const code = m.PART_NUM || m.CAT?.PROD_CODE || null;
      const name = m.DESC || m.CAT?.PROD_NAME || null;
      const match = matchItem(items, code, name);
      return {
        productId: null, // no Product2 link from FS -- new-item dedup falls back to code alone
        code,
        name,
        vendor: null,
        quantity: Number(m.QTY || 1),
        itemId: match?.id ?? null,
        itemName: match?.name ?? null,
        description: match ? (match.description || match.name) : name,
        takenFrom: m.TAKEN_FROM ?? null,
        existingPoNum: m.PO_NUM ?? null,
      };
    });
    return c.json({
      tech: doc.Data?.TECH ?? null,
      jobName: doc.Data?.JOB_NAME ?? null,
      jobWoNum: doc.Data?.JOB_WO_NUM ?? null,
      lines,
    });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /finance/po-customer-suggestions/:oppId
// The "Billing customer account" suggestion for a Service Call PO -- reuses
// Create Invoice's exact suggest-from-history logic (suggestCustomersForAccount,
// invoices.js), applied to a PO instead of an invoice. Not a Project lookup;
// this resolves the Opportunity's real Account and ranks prior
// Invoicing__c.QBO_Customer_Id__c values for that account, same as invoicing.
materialReqs.get('/finance/po-customer-suggestions/:oppId', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const oppId = c.req.param('oppId');
    const [opp] = await sf.query(`
      SELECT Id, ${f.oppAccountRelationship}.Id, ${f.oppAccountRelationship}.Name
      FROM Opportunity WHERE Id = '${esc(oppId)}' LIMIT 1
    `);
    if (!opp) return c.json({ error: 'Opportunity not found' }, 404);
    const accountId = opp[f.oppAccountRelationship]?.Id || null;
    const accountName = opp[f.oppAccountRelationship]?.Name ?? null;
    const suggestions = await suggestCustomersForAccount(c.env, sf, accountId);
    return c.json({ accountName, suggestions });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
