import { Hono } from 'hono';
import { config } from './config.js';
import { createSalesforce } from './salesforce.js';
import { createQbo } from './quickbooks.js';
import { createFs } from './fieldSquared.js';
import { esc, getTechDirectory } from './assignments.js';
import { getSalesItems, invalidateSalesItemsCache, matchItem, matchTechItem } from './qboShared.js';

const f = config.fields;
const inv = config.invoicing;
const o = config.objects;
const qcfg = config.qbo;

export const invoices = new Hono();

// Sales-item id/name/sku list, for the invoice line editor's manual item
// override picker (a labor line's auto-match was wrong, or a parts line
// needs a different item) -- mirrors purchaseOrders.js's GET /finance/qbo-items,
// just backed by getSalesItems() instead of the purchase-oriented list.
invoices.get('/finance/qbo-sales-items', async (c) => {
  try {
    const items = await getSalesItems(c.env);
    return c.json(items);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// ============================================================================
// SERVICE_ACK extraction helpers
// ============================================================================

// Populated DTBL5 rows only, with numeric hours and a resolved FS user id.
// TIME_CHARGED/TIME_WORKED are sometimes strings sometimes numbers (always
// Number()-coerce); USR2 is sometimes a bare FS User ExternalId string,
// sometimes a fully expanded user object (confirmed live, both real) --
// normalize to just the ExternalId either way. Rows missing TIME_IN or USR2
// are the empty placeholder slots FS documents are padded with (a real doc
// commonly has 90+ blank DTBL5 entries alongside 1-4 real ones) -- dropped.
export function extractDtbl5Rows(doc) {
  const rows = doc?.Data?.DTBL5 || [];
  return rows
    .filter((r) => r && r.TIME_IN)
    .map((r) => ({
      fsUserId: typeof r.USR2 === 'string' ? r.USR2 : (r.USR2?.ObjectId ?? null),
      hours: Number(r.TIME_CHARGED ?? r.TIME_WORKED ?? 0),
      date: String(r.TIME_IN).slice(0, 10), // YYYY-MM-DD, from TIME_IN -- NOT the top-level
      // DATE/DATE_COMPLETED fields, confirmed live 2026-08-25 to be unreliable
      // (found reversed relative to each other and to the real work dates on
      // a real doc; DTBL5[].TIME_IN is the only trustworthy source).
      // REP_TYPE (array, ~78% populated) -- confirmed live 2026-08-25 this IS
      // the real signal for which item a tech gets billed under once a visit
      // has more than one tech: on WO 53158's real invoice, the tech marked
      // REP_TYPE ["Installer"] was billed under his own named item, the one
      // marked REP_TYPE ["Helper"] was billed as plain "Helper" -- EVEN
      // THOUGH that second tech also has his own named item in the catalog.
      // Overturns this session's earlier (single-tech-only) conclusion that
      // REP_TYPE doesn't drive item selection -- it doesn't matter when
      // there's only one tech on a visit (no billing ambiguity either way),
      // but it's exactly what decides multi-tech visits.
      repType: Array.isArray(r.REP_TYPE) ? r.REP_TYPE : (r.REP_TYPE ? [r.REP_TYPE] : []),
    }))
    .filter((r) => r.fsUserId && r.date);
}

export function isHelperRow(row) {
  return row.repType.some((t) => (t || '').trim().toLowerCase() === 'helper');
}

// QBO's literal short TaxCodeRef codes ('TAX'/'NON'), derived from an Item's
// plain Taxable boolean -- confirmed live 2026-08-25 these Items carry no
// SalesTaxCodeRef field at all, just Taxable, and real sent invoices use
// exactly these two literal values per line. null when the matched item's
// taxable flag is unknown (e.g. no item matched at all) -- left for QBO/the
// office to apply its own default rather than guessing.
function taxCodeFor(item) {
  if (!item || item.taxable === null || item.taxable === undefined) return null;
  return item.taxable ? 'TAX' : 'NON';
}

// Group DTBL5 rows by distinct calendar date, NOT by row count -- confirmed
// live 2026-08-25: a real doc had 4 DTBL5 rows but only 2 distinct TIME_IN
// dates (2 techs each on 2 different dates), and its real sent invoice had
// exactly 2 repeated line groups (one per date), not 4. Multiple techs on
// the same date share one narrative block and one truck charge.
export function groupByDate(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dateRows]) => ({ date, rows: dateRows }));
}

// The FULL narrative block appears exactly ONCE per invoice (right after the
// anchor line), NOT repeated per date group -- corrected against WO 53158's
// real invoice (7849883): the first draft of this plan assumed it repeated
// per visit; the real lines show one combined block, then just a short
// per-date note before each group's tech/truck lines (see buildDateNote
// below). WORK_ORDERED_BY: useful for the office (who to call, sometimes
// which account placed the call) but not load-bearing -- best-effort, blank
// when absent, never blocks drafting.
function buildHeaderNarrative(data) {
  const parts = [];
  if (data?.WORK_SCOPE_SERVICE_DESC) parts.push(`Service Description / Work Scope: ${data.WORK_SCOPE_SERVICE_DESC}`);
  if (data?.ACTION_TAKEN) parts.push(`Action Taken: ${data.ACTION_TAKEN}`);
  if (data?.WORK_ORDERED_BY) parts.push(`Called in by: ${data.WORK_ORDERED_BY}`);
  return parts.join('\n\n') || null;
}

// Short per-date-group note. The real invoice's per-date line is actually
// pulled from within ACTION_TAKEN's own text (it turns out to already be
// loosely structured as one note per date) -- reproducing that exactly would
// be a fragile text parser that could break on messier real docs, so this
// stays simple and robust instead: just the date, editable.
function buildDateNote(date) {
  return `Service Date: ${date}`;
}

// Real EQUIPMENT_MATERIALS entries only -- like DTBL5, a doc is commonly
// padded with 15-20 empty placeholder slots alongside 0-few real ones.
function extractMaterials(doc) {
  return (doc?.Data?.EQUIPMENT_MATERIALS || []).filter((m) => m && (m.PART_NUM || m.CAT?.PROD_CODE || m.DESC));
}

// ============================================================================
// Customer crosswalk (point 3) -- ranked suggestions, never a single assumed-
// correct value. Confirmed live 2026-08-25: a single SF Account does not
// reliably map to one QBO Customer -- Accounts are often named after the
// property/building, not the paying company, and a multi-tenant building's
// Account can span dozens of real tenant AR codes across its job history.
// So this surfaces "previously billed to X (N times)" ranked by frequency,
// always user-confirmed -- most useful exactly on single-tenant Accounts
// where one name dominates, still honest (not misleading) on multi-tenant
// ones since the office can tell which real tenant this specific job is for.
export async function suggestCustomersForAccount(env, sf, accountId) {
  if (!inv.qboCustomerId || !accountId) return [];
  let rows;
  try {
    rows = await sf.query(`
      SELECT ${inv.qboCustomerId}
      FROM ${inv.sobject}
      WHERE Job__r.AccountId = '${esc(accountId)}' AND ${inv.qboCustomerId} != null
      ORDER BY CreatedDate DESC
      LIMIT 50
    `);
  } catch (e) {
    // Soft-fail if Invoicing__c.QBO_Customer_Id__c doesn't exist in this org
    // yet (a manual SF Setup step this feature depends on but doesn't
    // require to be usable) -- degrade to no suggestions rather than
    // breaking line drafting entirely.
    console.warn('suggestCustomersForAccount query failed (field may not exist yet):', e.message);
    return [];
  }
  const counts = new Map();
  for (const r of rows) {
    const id = r[inv.qboCustomerId];
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return [];
  const qbo = createQbo(env);
  const idList = ranked.map(([id]) => `'${esc(id)}'`).join(',');
  const customers = await qbo.queryAll('Customer', `WHERE Id IN (${idList})`);
  const nameById = new Map(customers.map((c) => [c.Id, c.DisplayName]));
  return ranked.map(([id, count]) => ({ qboCustomerId: id, name: nameById.get(id) || id, count }));
}

// ============================================================================
// Assignment cross-check (point 5a) -- informational only. Job_Assignment__c
// is crs-dispatch's own record of who was actually sent to a job; the FS
// SERVICE_ACK doc is an independent second source. They can drift. Never
// blocks anything -- just surfaces a plain-language note for the office.
// ============================================================================
function diffAssignmentsAgainstFs(assignmentRows, dateGroups, techDir) {
  const assignmentPairs = new Set(
    assignmentRows
      .filter((a) => a[o.assignmentTechRelationship]?.Name && a[o.assignmentDate])
      .map((a) => `${a[o.assignmentTechRelationship].Name}|${a[o.assignmentDate]}`)
  );
  const flags = [];
  for (const g of dateGroups) {
    for (const r of g.rows) {
      const techName = techDir.byFsId[r.fsUserId]?.name;
      if (!techName) continue;
      if (!assignmentPairs.has(`${techName}|${g.date}`)) {
        flags.push(`Field Squared shows ${techName} on ${g.date}, but crs-dispatch has no matching assignment for them that date -- worth checking before sending.`);
      }
    }
  }
  return flags;
}

// ============================================================================
// GET /finance/service-acks/:oppId
// The Opportunity's real (non-empty) SERVICE_ACK documents, for the picker.
// NOT a scan of FS's full document corpus -- confirmed live 2026-08-25 there
// is no server-side ownerid filter on /api/document (it silently ignores
// unknown params and returns literally everything, 12,679 docs / 18MB
// org-wide -- useless per-request). The real, scalable path: fs.getTask()
// returns .Documents, just that task's own document ids (confirmed live:
// matches exactly what the corpus scan found for the same job).
// ============================================================================
invoices.get('/finance/service-acks/:oppId', async (c) => {
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

    const task = await fs.getTask(fsTaskId);
    const docIds = task.Documents || (task.Docs || []).map((d) => d.ObjectId) || [];
    const techDir = await getTechDirectory(sf);

    const docs = [];
    for (const docId of docIds) {
      const r = await fs.getDocument(docId);
      if (!r.ok) continue;
      let doc;
      try { doc = JSON.parse(r.body); } catch { continue; }
      const rows = extractDtbl5Rows(doc);
      if (rows.length === 0) continue; // empty draft -- most docs tied to a job are, confirmed live
      const groups = groupByDate(rows);
      const materials = extractMaterials(doc);
      docs.push({
        docId,
        created: doc.Created,
        dates: groups.map((g) => g.date),
        techs: [...new Set(rows.map((r) => techDir.byFsId[r.fsUserId]?.name || r.fsUserId))],
        totalHours: rows.reduce((s, r) => s + r.hours, 0),
        hasParts: materials.length > 0,
      });
    }
    return c.json({ docs });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// ============================================================================
// GET /finance/service-acks/:oppId/:docId/lines
// One doc's drafted line groups, plus customer suggestions and assignment
// mismatch flags.
// ============================================================================
invoices.get('/finance/service-acks/:oppId/:docId/lines', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const fs = createFs(c.env);
    const oppId = c.req.param('oppId');
    const docId = c.req.param('docId');

    const [opp] = await sf.query(`
      SELECT Id, ${f.oppName}, ${f.oppLid}, ${f.oppJobNumber},
             ${f.oppAccountRelationship}.Id, ${f.oppAccountRelationship}.Name
      FROM Opportunity WHERE Id = '${esc(oppId)}' LIMIT 1
    `);
    if (!opp) return c.json({ error: 'Opportunity not found' }, 404);

    const [docRes, items, techDir, assignmentRows] = await Promise.all([
      fs.getDocument(docId),
      getSalesItems(c.env),
      getTechDirectory(sf),
      sf.query(`
        SELECT ${o.assignmentTechRelationship}.Name, ${o.assignmentDate}
        FROM ${o.assignment} WHERE ${o.assignmentOppLookup} = '${esc(oppId)}'
      `),
    ]);
    if (!docRes.ok) return c.json({ error: 'Could not load that document from Field Squared' }, 502);
    const doc = JSON.parse(docRes.body);
    const rows = extractDtbl5Rows(doc);
    if (rows.length === 0) return c.json({ error: 'This document has no completion data' }, 400);
    const groups = groupByDate(rows);

    const truckChargeItem = items.find((i) => (i.name || '').trim().toLowerCase() === 'truck charges') || null;
    const helperItem = items.find((i) => (i.name || '').trim().toLowerCase() === 'helper') || null;

    const headerNarrative = buildHeaderNarrative(doc.Data);

    const lineGroups = groups.map((g) => ({
      date: g.date,
      dateNote: buildDateNote(g.date),
      laborLines: g.rows.map((r) => {
        const techName = techDir.byFsId[r.fsUserId]?.name || null;
        // REP_TYPE "Helper" wins outright -- skip name matching entirely
        // (see extractDtbl5Rows' comment: confirmed live this is the real
        // signal once a visit has more than one tech, regardless of whether
        // that tech also has their own named item). Otherwise matchTechItem's
        // fallback chain (convention -> literal full name), falling back to
        // the generic Helper item if that fails too. Never auto-committed --
        // the frontend always shows what matched and lets the office
        // override it via a manual item search.
        const forcedHelper = isHelperRow(r);
        const matched = !forcedHelper && techName ? matchTechItem(items, techName) : null;
        const resolved = matched || helperItem;
        return {
          fsUserId: r.fsUserId,
          techName: techName || '(unresolved Field Squared user)',
          hours: r.hours,
          repType: r.repType,
          itemId: resolved?.id ?? null,
          itemName: resolved?.name ?? null,
          rate: resolved?.unitPrice ?? null,
          taxCodeRef: taxCodeFor(resolved),
          matchedByName: !!matched,
        };
      }),
      truckCharge: truckChargeItem
        ? {
            itemId: truckChargeItem.id,
            itemName: truckChargeItem.name,
            rate: truckChargeItem.unitPrice,
            taxCodeRef: taxCodeFor(truckChargeItem),
          }
        : null,
    }));

    // Parts -- rate ALWAYS from the matched QBO Item's own UnitPrice, NEVER
    // from FS's CAT.PRICE. Confirmed live 2026-08-25: a real doc's FRM-1
    // recorded CAT.PRICE of $45.75 vs. the real invoice's actual $197.16 --
    // FS's recorded price is not just unused, it's off by 4x. CAT.PRODCODE/
    // PROD_NAME are still useful for matching WHICH item, just never for what
    // to charge.
    const materials = extractMaterials(doc);
    const partsLines = materials.map((m) => {
      const code = m.PART_NUM || m.CAT?.PROD_CODE || null;
      const name = m.DESC || m.CAT?.PROD_NAME || null;
      const match = matchItem(items, code, name);
      return {
        code,
        name,
        qty: Number(m.QTY || 1),
        itemId: match?.id ?? null,
        itemName: match?.name ?? null,
        rate: match?.unitPrice ?? null,
        taxCodeRef: taxCodeFor(match),
        matched: !!match,
      };
    });

    const accountId = opp[f.oppAccountRelationship]?.Id || null;
    const customerSuggestions = await suggestCustomersForAccount(c.env, sf, accountId);
    const assignmentFlags = diffAssignmentsAgainstFs(assignmentRows, groups, techDir);

    return c.json({
      opportunity: { id: opp.Id, name: opp[f.oppName], lid: opp[f.oppLid] ?? null, accountName: opp[f.oppAccountRelationship]?.Name ?? null },
      anchorLine: opp[f.oppName],
      headerNarrative,
      groups: lineGroups,
      partsLines,
      partsRecorded: materials.length > 0,
      customerSuggestions,
      assignmentFlags,
    });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Next Invoice DocNumber -- unlike PurchaseOrder's "YY-NNNN" human scheme,
// real sent invoice DocNumbers are plain sequential integers (e.g.
// "7849883", confirmed live against real sent invoices spanning a tight,
// consistently-increasing numeric band). SalesFormsPrefs.CustomTxnNumbers is
// confirmed ON company-wide (same preference Create PO's nextDocNumber
// depends on), so this needs to be computed the same reason -- QBO won't
// auto-assign one. Scans the most recent Invoices and takes max+1.
async function nextInvoiceDocNumber(qbo) {
  const qr = await qbo.query('SELECT DocNumber FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 50');
  let max = 0;
  for (const r of qr.Invoice || []) {
    const m = /^(\d+)/.exec(r.DocNumber || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1);
}

// ============================================================================
// POST /finance/invoices
// Body: { oppId, docId, customerId, anchorLine,
//         groups: [{ date, narrative, laborLines: [{itemId, itemName, hours,
//                     rate, taxCodeRef}], truckCharge: {...}|null }],
//         partsLines: [{itemId?, itemName?, qty, rate, taxCodeRef,
//                        newItem?: {code, description}}] }
// Always creates EmailStatus: 'NotSet' -- unsent, same "billed = sent only"
// rule as everywhere else in this app. The office reviews tax and sends it
// from QBO itself.
// ============================================================================
invoices.post('/finance/invoices', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const qbo = createQbo(c.env);
    const body = await c.req.json();
    const { oppId, customerId, anchorLine, headerNarrative, groups, partsLines } = body;
    if (!oppId || !customerId || !anchorLine || !Array.isArray(groups) || groups.length === 0) {
      return c.json({ error: 'oppId, customerId, anchorLine, and at least one line group are required' }, 400);
    }

    // Create any missing parts Items first (dedupe by code) -- same pattern
    // as purchaseOrders.js: an unmatched part gets a real Item, never a
    // generic bucket line.
    const resolvedItemId = new Map();
    const needsNewItem = (partsLines || []).some((p) => !p.itemId && p.newItem?.code);
    if (needsNewItem) {
      const accounts = await qbo.queryAll('Account', `WHERE Name = '${qcfg.defaultExpenseAccountName}'`);
      const defaultAccount = accounts[0];
      if (!defaultAccount) return c.json({ error: `QBO Account "${qcfg.defaultExpenseAccountName}" not found` }, 500);
      for (const p of partsLines) {
        if (p.itemId || !p.newItem?.code) continue;
        const key = p.newItem.code;
        if (resolvedItemId.has(key)) continue;
        const code = key.trim().slice(0, 100);
        const created = await qbo.create('item', {
          Name: code,
          Sku: code,
          Description: p.newItem.description || code,
          Type: 'NonInventory',
          IncomeAccountRef: { value: defaultAccount.Id },
          ExpenseAccountRef: { value: defaultAccount.Id },
        });
        resolvedItemId.set(key, { id: created.Id, name: created.Name });
      }
      await invalidateSalesItemsCache(c.env);
    }

    // Line 1 is always the Opportunity's exact Name (the link-back anchor),
    // then the ONE combined narrative block once -- NOT repeated per group,
    // confirmed against WO 53158's real invoice (7849883). Each date group
    // below gets only its own short dateNote, not the full narrative again.
    const lines = [{ DetailType: 'DescriptionOnly', Description: String(anchorLine) }];
    if (headerNarrative) lines.push({ DetailType: 'DescriptionOnly', Description: String(headerNarrative) });

    for (const g of groups) {
      if (g.dateNote) lines.push({ DetailType: 'DescriptionOnly', Description: String(g.dateNote) });
      for (const l of (g.laborLines || [])) {
        if (!l.itemId || !Number(l.hours)) continue;
        lines.push({
          DetailType: 'SalesItemLineDetail',
          Amount: Number(l.hours) * Number(l.rate || 0),
          SalesItemLineDetail: {
            ItemRef: { value: l.itemId, name: l.itemName || undefined },
            Qty: Number(l.hours),
            UnitPrice: Number(l.rate || 0),
            ...(l.taxCodeRef ? { TaxCodeRef: { value: l.taxCodeRef } } : {}),
          },
        });
      }
      if (g.truckCharge?.itemId) {
        lines.push({
          DetailType: 'SalesItemLineDetail',
          Amount: Number(g.truckCharge.rate || 0),
          SalesItemLineDetail: {
            ItemRef: { value: g.truckCharge.itemId, name: g.truckCharge.itemName || undefined },
            Qty: 1,
            UnitPrice: Number(g.truckCharge.rate || 0),
            ...(g.truckCharge.taxCodeRef ? { TaxCodeRef: { value: g.truckCharge.taxCodeRef } } : {}),
          },
        });
      }
    }

    for (const p of (partsLines || [])) {
      const resolved = p.itemId ? { id: p.itemId, name: p.itemName } : resolvedItemId.get(p.newItem?.code);
      if (!resolved) continue;
      const qty = Number(p.qty || 1);
      const rate = Number(p.rate || 0);
      lines.push({
        DetailType: 'SalesItemLineDetail',
        Amount: qty * rate,
        SalesItemLineDetail: {
          ItemRef: { value: resolved.id, name: resolved.name || undefined },
          Qty: qty,
          UnitPrice: rate,
          ...(p.taxCodeRef ? { TaxCodeRef: { value: p.taxCodeRef } } : {}),
        },
      });
    }

    if (lines.length <= 1) return c.json({ error: 'No billable lines to invoice' }, 400);

    // Real Customer lookup -- per direction 2026-08-27, fixing three real
    // bugs reported live on a just-created invoice:
    //   1. CustomerRef with only `value` (no `name`) left the QBO invoice
    //      screen's own Customer picker showing the right name as text but
    //      not actually bound to it -- had to be manually reselected from
    //      the dropdown to "take". Sending the real DisplayName alongside
    //      the Id fixes that.
    //   2. BillEmail was never set at all, so the customer's real on-file
    //      email never carried onto the invoice. Confirmed live: 1,396 of
    //      2,072 real QBO customers (67%) have a real PrimaryEmailAddr --
    //      set it whenever present, silently omitted otherwise.
    //   3. SalesTermRef was never set, so QBO fell back to whatever term
    //      happens to be the customer's own default. Every invoice this app
    //      creates is service work -- always "Due on receipt" (real Term.Id
    //      '34' in this company file, see config.qbo.dueOnReceiptTermId).
    // (ShipAddr is deliberately left untouched -- the invoice screen's own
    // apparent "shipping address" on first open is QBO previewing the
    // customer's stored ship-to before the real, unset value reloads; not
    // something this app ever sends or should suppress.)
    let customerName;
    let customerEmail;
    try {
      const cr = await qbo.query(`SELECT Id, DisplayName, PrimaryEmailAddr FROM Customer WHERE Id = '${customerId}'`);
      const cust = (cr.Customer || [])[0];
      customerName = cust?.DisplayName;
      customerEmail = cust?.PrimaryEmailAddr?.Address;
    } catch {
      // Best-effort -- CustomerRef.value alone still links the invoice
      // correctly even if this lookup fails.
    }

    const invBody = {
      CustomerRef: { value: customerId, ...(customerName ? { name: customerName } : {}) },
      ...(customerEmail ? { BillEmail: { Address: customerEmail } } : {}),
      SalesTermRef: { value: qcfg.dueOnReceiptTermId },
      Line: lines,
      EmailStatus: 'NotSet',
    };

    const [opp] = await sf.query(`SELECT Id, ${f.oppLid} FROM Opportunity WHERE Id = '${esc(oppId)}' LIMIT 1`);
    if (opp?.[f.oppLid] && qcfg.invoiceCustomFields?.lid) {
      invBody.CustomField = [{
        DefinitionId: qcfg.invoiceCustomFields.lid.definitionId,
        Name: qcfg.invoiceCustomFields.lid.name,
        Type: 'StringType',
        StringValue: String(opp[f.oppLid]),
      }];
    }

    invBody.DocNumber = await nextInvoiceDocNumber(qbo);
    let created;
    try {
      created = await qbo.create('invoice', invBody);
    } catch (e) {
      if (!/duplicate|docnumber/i.test(e.message)) throw e;
      invBody.DocNumber = String(parseInt(invBody.DocNumber, 10) + 1);
      created = await qbo.create('invoice', invBody);
    }

    const total = created.TotalAmt ?? lines.reduce((s, l) => s + (l.Amount || 0), 0);

    // Deliberately no Invoicing__c write here -- per direction 2026-08-26,
    // this tool only ever creates the QBO Invoice (unsent). The Salesforce
    // mirror record is created by a separate process, triggered when the
    // invoice is actually sent from QuickBooks, not at draft time. Writing
    // it here as well was landing a premature/duplicate SF record every time
    // this route ran (confirmed live against a real job, WO 52957).
    return c.json({ id: created.Id, docNumber: created.DocNumber, total });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
