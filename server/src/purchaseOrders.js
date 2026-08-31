import { Hono } from 'hono';
import { config } from './config.js';
import { createSalesforce } from './salesforce.js';
import { createQbo } from './quickbooks.js';
import { esc } from './assignments.js';
import { getUsableItems, invalidateItemsCache, matchItem } from './qboShared.js';

const f = config.fields;
const qcfg = config.qbo;

// Vendor__c values that mean "internal/labor, not a real purchasable vendor" -
// used only for the informational vendor-list preview on GET /finance/po-source
// (see below) -- confirmed live 2026-08-21, this field alone is too
// unreliable (only ~54% of lines carry a real one) to gate which lines are
// offered as PO-sourceable.
const NON_VENDOR = new Set(['', 'CRS', 'N/A']);

function isRealVendor(v) {
  return !!v && !NON_VENDOR.has(v);
}

// Product2.Family codes that are never real vendor-purchasable material --
// confirmed live 2026-08-21 against this org's real values ("7000 – Labor",
// "8000 – Other" - Lead/Help/Permits/Drawing Review/Quote Prep/Per Diem/
// Miscellaneous). Matched by numeric prefix so the exact dash character
// doesn't matter. This is the real exclusion signal for the PO line list
// (Vendor__c isn't reliable enough on its own -- see NON_VENDOR above).
const NON_MATERIAL_FAMILY_PREFIXES = ['7000', '8000'];

export function isMaterialFamily(family) {
  if (!family) return true; // no Family at all -- don't assume it's excludable
  return !NON_MATERIAL_FAMILY_PREFIXES.some((p) => family.trim().startsWith(p));
}

// Sibling to isMaterialFamily above, for the Expense Tracking detail view's
// quoted-labor breakdown (jobCost.js) -- Family starting with "7000" is the
// real labor signal (confirmed live 2026-08-21 alongside "8000" - Other).
export function isLaborFamily(family) {
  return !!family && family.trim().startsWith('7000');
}

// getUsableItems / matchItem moved to qboShared.js (2026-08-25, shared with
// the new invoices.js) -- imported above.

export const purchaseOrders = new Hono();

// Per-Opportunity quote source data for the Create PO modal's opportunity ->
// quote-picker step. Batched (one call for every selected Opportunity) rather
// than one request per row. Deliberately does NOT try to resolve
// Awarded_Quote__c by text match -- confirmed live it's a display string, not
// a working lookup (see purchase-order plan). The real link is
// Quote.OpportunityId, and an Opportunity may have zero, one, or several
// Quotes -- all three are real, live cases (40% / 52% / 9% of a recent
// sample), so the frontend always shows the quote list and lets the user
// pick, never auto-selects "most recent".
purchaseOrders.get('/finance/po-source', async (c) => {
  try {
    const idsParam = c.req.query('oppIds') || '';
    const oppIds = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (oppIds.length === 0) return c.json({ error: 'oppIds required' }, 400);
    const idList = oppIds.map((id) => `'${esc(id)}'`).join(',');

    const sf = createSalesforce(c.env);

    const opps = await sf.query(`
      SELECT Id, ${f.oppName}, ${f.oppLid}, ${f.oppJobNumber}, ${f.oppQboProjectId},
             ${f.oppAccountRelationship}.Name, ${f.addrStreet}, ${f.addrCity}, ${f.addrState}, ${f.addrZip}
      FROM Opportunity WHERE Id IN (${idList})
    `);

    const quotes = await sf.query(`
      SELECT Id, Name, QuoteNumber, Status, GrandTotal, CreatedDate, OpportunityId
      FROM Quote WHERE OpportunityId IN (${idList}) ORDER BY CreatedDate DESC
    `);

    // One extra query for every quote's vendor list, grouped client-side --
    // same flat-query-then-group convention as parts.js's inventory grouping.
    const vendorsByQuoteId = new Map();
    if (quotes.length) {
      const quoteIdList = quotes.map((q) => `'${esc(q.Id)}'`).join(',');
      const lines = await sf.query(`
        SELECT QuoteId, Product2.Vendor__c FROM QuoteLineItem WHERE QuoteId IN (${quoteIdList})
      `);
      for (const l of lines) {
        const v = l.Product2?.Vendor__c;
        if (!isRealVendor(v)) continue;
        if (!vendorsByQuoteId.has(l.QuoteId)) vendorsByQuoteId.set(l.QuoteId, new Set());
        vendorsByQuoteId.get(l.QuoteId).add(v);
      }
    }

    const quotesByOppId = new Map();
    for (const q of quotes) {
      if (!quotesByOppId.has(q.OpportunityId)) quotesByOppId.set(q.OpportunityId, []);
      quotesByOppId.get(q.OpportunityId).push({
        id: q.Id,
        name: q.Name,
        quoteNumber: q.QuoteNumber,
        status: q.Status,
        grandTotal: q.GrandTotal ?? 0,
        createdDate: q.CreatedDate,
        vendors: [...(vendorsByQuoteId.get(q.Id) || [])],
      });
    }

    const result = opps.map((o) => ({
      id: o.Id,
      name: o[f.oppName],
      lid: o[f.oppLid] ?? null,
      jobNumber: o[f.oppJobNumber] ?? null,
      // Service Stock's crosswalk starts out blank -- nothing has ever
      // written it, since Service Stock hadn't gone through a real PO
      // before this feature. Falls back to the already-known real QBO
      // Customer id (env var, wrangler.toml) instead of leaving the
      // frontend to think no Project exists and offer to create a
      // redundant new one. The very next Service Stock PO created writes
      // this back onto the real field via the normal write-back path below,
      // so the fallback is only ever exercised until that first write lands.
      qboProjectId: o[f.oppQboProjectId] || (o.Id === c.env.SERVICE_STOCK_OPPORTUNITY_ID ? (c.env.SERVICE_STOCK_QBO_CUSTOMER_ID || null) : null),
      accountName: o[f.oppAccountRelationship]?.Name ?? null,
      address: {
        street: o[f.addrStreet] ?? null,
        city: o[f.addrCity] ?? null,
        state: o[f.addrState] ?? null,
        zip: o[f.addrZip] ?? null,
      },
      quotes: quotesByOppId.get(o.Id) || [],
    }));

    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// A single quote's line list, for the PO builder's line step once a quote is
// picked. Excludes labor/overhead lines by Product2.Family (see
// isMaterialFamily above) -- NOT by Vendor__c, which is too unreliable on
// its own (only ~54% of real lines carry one; a real quote with 17 lines had
// only 2 vendor-tagged, but plenty of the untagged ones were genuine
// material like power supplies and strobes). Everything left is offered as
// a PO line candidate, with the vendor tag shown as a hint, not a filter --
// isRealVendor is still used for the lighter-weight vendor-list preview on
// GET /finance/po-source, where "what vendors touch this quote" is only
// informational.
// Quantity comes from the quote; price does NOT -- QuoteLineItem.UnitPrice is
// the customer sale price, not vendor cost, so it's deliberately left out of
// this response. The frontend always collects cost as a fresh manual entry.
// Each line also carries its matched QBO Item (matchItem() above), if any --
// this is the actual product identity shown to the user before they submit,
// not just descriptive text -- and what the create route uses so the PO line
// lands as a real per-SKU Item, not a generic bucket.
// `description` is ALWAYS a single real field pulled verbatim from an
// existing record -- never a concatenation -- confirmed live 2026-08-24: the
// matched QBO Item's own Description (e.g. "12V 7AH SLA BATTERY F1") takes
// priority when there's a match, since that's what's actually authoritative
// for that Item; only when nothing's matched yet does it fall back to
// Salesforce's own Product2.Name. NOT Product2.Description -- confirmed live
// 2026-08-24 that field is repurposed in this org for brand/vendor tags and
// status flags ("AMAG", "Schlage", "INACTIVE", "Home Depot" -- 71% of a
// sampled active-product set), not real descriptive text, so it's actively
// misleading here despite the field name.
purchaseOrders.get('/finance/quotes/:quoteId/lines', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const quoteId = c.req.param('quoteId');
    const [lines, items] = await Promise.all([
      sf.query(`
        SELECT Id, Product2Id, Product2.Name, Product2.ProductCode, Product2.StockKeepingUnit,
               Product2.Vendor__c, Product2.Family, Quantity
        FROM QuoteLineItem WHERE QuoteId = '${esc(quoteId)}'
      `),
      getUsableItems(c.env),
    ]);
    const eligible = lines
      .filter((l) => isMaterialFamily(l.Product2?.Family))
      .map((l) => {
        // StockKeepingUnit is SF's standard "real manufacturer SKU" field,
        // distinct from ProductCode (CRS's own internal part code) --
        // confirmed live 2026-08-24 they can genuinely differ (e.g.
        // ProductCode "PE-HSWC" vs. the real vendor SKU on the part's own
        // box). Rarely populated (~2% of active products) but preferred
        // over ProductCode for both matching and the create-item prefill
        // when it is, since it's the more authoritative value.
        const code = l.Product2?.StockKeepingUnit || l.Product2?.ProductCode || null;
        const match = matchItem(items, code, l.Product2?.Name);
        return {
          productId: l.Product2Id,
          name: l.Product2?.Name ?? null,
          code,
          vendor: isRealVendor(l.Product2?.Vendor__c) ? l.Product2.Vendor__c : null,
          quantity: l.Quantity ?? 0,
          itemId: match?.id ?? null,
          itemName: match?.name ?? null,
          description: match ? (match.description || match.name) : (l.Product2?.Name ?? null),
        };
      });
    return c.json(eligible);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Usable QBO Item id/name/sku list, for the PO builder's per-line item
// picker (manual override, or a line with no auto-match). See getUsableItems.
purchaseOrders.get('/finance/qbo-items', async (c) => {
  try {
    const items = await getUsableItems(c.env);
    return c.json(items);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// QBO Vendor id/name list for the PO builder's vendor picker. KV-cached
// (~30m), same pattern as parts.js's /parts/catalog -- a vendor list changes
// rarely and this app never writes to Vendor, so a plain TTL is enough.
purchaseOrders.get('/finance/qbo-vendors', async (c) => {
  try {
    const KV = c.env.SF_TOKENS;
    const CACHE_KEY = 'qbo_vendors_v1';
    const CACHE_TTL = 1800;
    let vendors = KV ? await KV.get(CACHE_KEY, 'json') : null;
    if (!vendors) {
      const qbo = createQbo(c.env);
      const rows = await qbo.queryAll('Vendor');
      vendors = rows.map((v) => ({ id: v.Id, name: v.DisplayName })).sort((a, b) => a.name.localeCompare(b.name));
      if (KV) await KV.put(CACHE_KEY, JSON.stringify(vendors), { expirationTtl: CACHE_TTL });
    }
    return c.json(vendors);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Salesforce SFDC_Vendor__c id/name list -- the real-world vendor object the
// org's own "CRS Purchase Order" (Opportunity__c) write-back links to, a
// completely different system from QBO's own Vendor object above (no shared
// crosswalk field exists between the two -- confirmed live 2026-08-26 via a
// full describe of SFDC_Vendor__c). Matching between them is name-based,
// suggest-and-confirm, same as everywhere else in this app. KV-cached same
// pattern as qbo-vendors.
purchaseOrders.get('/finance/sfdc-vendors', async (c) => {
  try {
    const KV = c.env.SF_TOKENS;
    const CACHE_KEY = 'sfdc_vendors_v1';
    const CACHE_TTL = 1800;
    let vendors = KV ? await KV.get(CACHE_KEY, 'json') : null;
    if (!vendors) {
      const sf = createSalesforce(c.env);
      const rows = await sf.query('SELECT Id, Name FROM SFDC_Vendor__c ORDER BY Name');
      vendors = rows.map((v) => ({ id: v.Id, name: v.Name }));
      if (KV) await KV.put(CACHE_KEY, JSON.stringify(vendors), { expirationTtl: CACHE_TTL });
    }
    return c.json(vendors);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// SFDC_Cost_Center__c id/name list -- "CRS Purchase Order" (Opportunity__c)
// has a hard validation rule requiring this field (found live 2026-08-26 --
// not a plain required-field flag, so a describe check didn't catch it: a
// real create failed with "Required fields are missing: [Cost_Center__c]").
// Only 11 real options exist, and despite the generic name they're mostly
// vendor-named categories -- confirmed live against 40 real recent
// Opportunity__c records: 35 exact-name matches against CRS_Vendor__r.Name,
// the rest close substring matches ("JLM Wholesale SE, Inc." -> "JLM"), only
// 1 genuine anomaly. So this is suggested by the same name-match-and-confirm
// convention as everywhere else, keyed off whichever vendor is picked. KV-
// cached same pattern.
purchaseOrders.get('/finance/cost-centers', async (c) => {
  try {
    const KV = c.env.SF_TOKENS;
    const CACHE_KEY = 'sfdc_cost_centers_v1';
    const CACHE_TTL = 1800;
    let centers = KV ? await KV.get(CACHE_KEY, 'json') : null;
    if (!centers) {
      const sf = createSalesforce(c.env);
      const rows = await sf.query('SELECT Id, Name FROM SFDC_Cost_Center__c ORDER BY Name');
      centers = rows.map((v) => ({ id: v.Id, name: v.Name }));
      if (KV) await KV.put(CACHE_KEY, JSON.stringify(centers), { expirationTtl: CACHE_TTL });
    }
    return c.json(centers);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// QBO "Projects" (Job:true sub-Customers) + their top-level parent Customers,
// for the PO builder's project-resolution step -- picking an existing
// Project, or picking a parent to create a new one under. Same KV-cache
// pattern as qbo-vendors above; one Customer pull covers both lists.
purchaseOrders.get('/finance/qbo-projects', async (c) => {
  try {
    const KV = c.env.SF_TOKENS;
    const CACHE_KEY = 'qbo_projects_v1';
    const CACHE_TTL = 1800;
    let data = KV ? await KV.get(CACHE_KEY, 'json') : null;
    if (!data) {
      const qbo = createQbo(c.env);
      const rows = await qbo.queryAll('Customer');
      const projects = [];
      const parents = [];
      for (const cust of rows) {
        if (cust.Active === false) continue;
        const shaped = {
          id: cust.Id,
          name: cust.DisplayName,
          fullyQualifiedName: cust.FullyQualifiedName ?? cust.DisplayName,
          parentId: cust.ParentRef?.value ?? null,
        };
        if (cust.Job === true) projects.push(shaped);
        else parents.push(shaped);
      }
      data = { projects, parents };
      if (KV) await KV.put(CACHE_KEY, JSON.stringify(data), { expirationTtl: CACHE_TTL });
    }
    return c.json(data);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Next sequential PO number, matching this company's real, human-entered
// scheme (confirmed live 2026-08-21: "26-0143" = 2-digit year + a running
// 4-digit sequence, no reset seen within a year). QBO's own "Custom
// Transaction Numbers" preference is ON for this company (confirmed via the
// Preferences endpoint) -- meaning QBO does NOT auto-assign a DocNumber on
// create the way it does when that preference is off: two records created
// via the API during testing came back with DocNumber undefined. There's no
// hidden server-side counter to "throw off" by computing this ourselves --
// it's the same thing the QBO UI itself does (suggest the next number by
// scanning existing ones). The only real risk is two POs created
// concurrently colliding on the same number; createPurchaseOrder() below
// retries once with the next number up if that happens.
async function nextDocNumber(qbo) {
  const year2 = String(new Date().getFullYear()).slice(-2);
  const qr = await qbo.query(`SELECT DocNumber FROM PurchaseOrder WHERE DocNumber LIKE '${year2}-%' MAXRESULTS 1000`);
  let max = 0;
  for (const r of qr.PurchaseOrder || []) {
    const m = /^(\d{2})-(\d+)$/.exec(r.DocNumber || '');
    if (m && m[1] === year2) max = Math.max(max, parseInt(m[2], 10));
  }
  return `${year2}-${String(max + 1).padStart(4, '0')}`;
}

// Create the PO. Body:
//   { vendorId, lines: [{ opportunityId, description, quantity, unitCost,
//                          itemId?, itemName?,
//                          newItem?: { productId, code, description },
//                          customerId?,
//                          projectId?, newProject?: { parentCustomerId, displayName } }] }
// Each line needs exactly one of: customerId (a real top-level QBO Customer
// -- the Service Call PO path, added 2026-08-31, no Project involved at
// all), projectId (an existing Job:true sub-Customer), or newProject (create
// one). The Service Stock PO path uses projectId/newProject like any other
// job -- its Opportunity is just always the fixed Service Stock id.
// Order of operations, in one request:
//   1. For each distinct opportunityId needing a new Project (no projectId
//      given, and no customerId either), create it in QBO, then upsert
//      QBO_Project_Id__c on that Opportunity -- so the NEXT PO against the
//      same job resolves instantly via the stored crosswalk instead of
//      re-matching or duplicating.
//   2. Also upsert QBO_Project_Id__c for opportunities that resolved to an
//      EXISTING project the user picked manually (idempotent either way --
//      memoizes the match regardless of how it was found). A line carrying
//      customerId skips this entirely -- it was never a Project, so there's
//      nothing to memoize; every Service Call PO re-suggests fresh.
//   3. For each distinct newItem (deduped by productId, so two lines for the
//      same Salesforce product don't create two QBO Items), create it as a
//      real Item -- per direction: an unmatched part gets a proper
//      Product/Service record, never just dumped into a generic account
//      line. Invalidates the Items cache so it's searchable immediately.
//   4. Build the PurchaseOrder body -- one line per input line, CustomerRef =
//      that line's resolved Project, ItemBasedExpenseLineDetail against the
//      line's matched/picked/just-created QBO Item (the normal case now --
//      see matchItem()), else AccountBasedExpenseLineDetail against the
//      default expense account as a last-resort fallback (a fully manual
//      line with no source product and no item picked at all). Only stamp
//      the PO-level LID#/Job-WO# CustomFields when every line shares the
//      same Opportunity (a multi-job PO has no single correct value for a
//      PO-level field -- the real per-line signal is CustomerRef, which is
//      why those two CustomFields are a secondary/best-effort tag, never
//      depended on).
//   5. Create the PurchaseOrder itself, with a generated DocNumber (see
//      nextDocNumber above), retrying once on an apparent number collision.
purchaseOrders.post('/finance/purchase-orders', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const qbo = createQbo(c.env);
    const { vendorId, sfdcVendorId, costCenterId, lines } = await c.req.json();
    if (!vendorId) return c.json({ error: 'vendorId required' }, 400);
    const clean = Array.isArray(lines)
      ? lines.filter((l) => l?.opportunityId && l.description && Number(l.quantity) > 0)
      : [];
    if (clean.length === 0) return c.json({ error: 'At least one line is required' }, 400);

    // Step 1/2 -- resolve one QBO CustomerRef per distinct opportunityId in
    // the line set. Two shapes, per line:
    //   - `customerId` -- a real, TOP-LEVEL QBO Customer, no Project involved
    //     at all. This is the Service Call PO path: posts directly against a
    //     real customer (chosen via the same suggest-from-invoice-history
    //     logic Create Invoice uses, GET /finance/po-customer-suggestions/:oppId
    //     -- see materialReqs.js), never resolved/created as a Job:true
    //     sub-Customer, and never written back to QBO_Project_Id__c -- it was
    //     never a Project, so there's nothing to memoize; every Service Call
    //     PO re-suggests fresh next time. Per direction 2026-08-31.
    //   - `projectId` / `newProject` -- the original Job-PO behavior,
    //     unchanged: resolve/create a Job:true sub-Customer and memoize the
    //     crosswalk. Also what the Service Stock path uses under the hood
    //     (its Opportunity is always the fixed Service Stock id, resolved the
    //     same way any other job's Project is).
    // A single opportunityId's lines are assumed to agree on which shape
    // they use -- the frontend only ever produces one shape per opportunity
    // per PO, same convention as the original per-opp project resolution.
    const oppIds = [...new Set(clean.map((l) => l.opportunityId))];
    const resolvedCustomerRef = new Map(); // opportunityId -> QBO Customer Id (a Project OR a plain top-level Customer)
    const projectOppIds = []; // subset of oppIds that actually went through Project resolution -- only these get the SF crosswalk write below

    for (const oppId of oppIds) {
      const line = clean.find((l) => l.opportunityId === oppId);
      if (line.customerId) {
        resolvedCustomerRef.set(oppId, line.customerId);
        continue;
      }
      projectOppIds.push(oppId);
      if (line.projectId) {
        resolvedCustomerRef.set(oppId, line.projectId);
        continue;
      }
      if (!line.newProject?.parentCustomerId || !line.newProject?.displayName) {
        return c.json({ error: `Line for Opportunity ${oppId} has none of customerId, an existing projectId, or a complete newProject` }, 400);
      }
      const created = await qbo.create('customer', {
        DisplayName: line.newProject.displayName,
        Job: true,
        ParentRef: { value: line.newProject.parentCustomerId },
      });
      resolvedCustomerRef.set(oppId, created.Id);
    }

    // Memoize every Project resolution (existing-match or newly-created) back
    // onto the Opportunity -- an idempotent write. Only for opportunities
    // that went through Project resolution at all; a direct customerId line
    // never touches QBO_Project_Id__c.
    await Promise.all(
      projectOppIds.map((oppId) => sf.updateRecord('Opportunity', oppId, { [f.oppQboProjectId]: resolvedCustomerRef.get(oppId) }))
    );

    // Step 3 -- default expense account. Needed both as the account newly
    // created Items get, and as the last-resort fallback for a line with no
    // item at all (AccountBasedExpenseLineDetail). Resolved once regardless
    // of whether any line actually needs it -- cheap, simpler than
    // conditionally skipping it.
    const accounts = await qbo.queryAll('Account', `WHERE Name = '${qcfg.defaultExpenseAccountName}'`);
    const defaultAccount = accounts[0];
    if (!defaultAccount) return c.json({ error: `QBO Account "${qcfg.defaultExpenseAccountName}" not found` }, 500);

    // Step 3 (cont'd) -- create any missing Items, one per distinct source
    // product (a productId can appear on more than one line if the same
    // part shows up on multiple quotes in this PO).
    const resolvedItemId = new Map(); // dedupe key (productId or code) -> {id, name}
    for (const l of clean) {
      if (l.itemId || !l.newItem?.code) continue;
      const dedupeKey = l.newItem.productId || l.newItem.code;
      if (resolvedItemId.has(dedupeKey)) continue;
      // Name and Sku are the SAME value (the code) -- matches how real Items
      // in this org actually look (Name IS the SKU-like code on almost
      // every one; a separately-populated Sku is rare, ~2% of the catalog).
      // Confirmed live 2026-08-24: a prior version let a hidden Sku default
      // silently override whatever the user typed as "Name", so an empty
      // code fell back to the long product description landing in the
      // wrong field. One field now, used identically for both.
      const code = l.newItem.code.trim().slice(0, 100);
      const created = await qbo.create('item', {
        Name: code,
        Sku: code,
        Description: l.newItem.description || code,
        Type: 'NonInventory',
        IncomeAccountRef: { value: defaultAccount.Id },
        ExpenseAccountRef: { value: defaultAccount.Id },
      });
      resolvedItemId.set(dedupeKey, { id: created.Id, name: created.Name });
    }
    if (resolvedItemId.size) await invalidateItemsCache(c.env);

    const poLines = clean.map((l) => {
      const customerRef = { value: resolvedCustomerRef.get(l.opportunityId) };
      const newItemResolved = l.newItem ? resolvedItemId.get(l.newItem.productId || l.newItem.code) : null;
      const itemId = l.itemId || newItemResolved?.id;
      const itemName = l.itemName || newItemResolved?.name;
      if (itemId) {
        return {
          DetailType: 'ItemBasedExpenseLineDetail',
          Description: l.description,
          Amount: Number(l.quantity) * Number(l.unitCost || 0),
          ItemBasedExpenseLineDetail: {
            ItemRef: { value: itemId, name: itemName || undefined },
            Qty: Number(l.quantity),
            UnitPrice: Number(l.unitCost || 0),
            CustomerRef: customerRef,
          },
        };
      }
      // Last-resort fallback -- only reachable for a fully manual line with
      // no source product and no item picked at all.
      return {
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: l.description,
        Amount: Number(l.quantity) * Number(l.unitCost || 0),
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: defaultAccount.Id, name: defaultAccount.Name },
          CustomerRef: customerRef,
        },
      };
    });

    // QBO rejects a PurchaseOrder with no APAccountRef ("Select an account
    // for this transaction") -- confirmed live 2026-08-21, not defaulted the
    // way the docs imply. This company file has exactly one Accounts Payable
    // account, so just resolve it by AccountType rather than hardcoding an Id.
    const apAccounts = await qbo.queryAll('Account', "WHERE AccountType = 'Accounts Payable'");
    const apAccount = apAccounts[0];
    if (!apAccount) return c.json({ error: 'No QBO Accounts Payable account found' }, 500);

    const body = { VendorRef: { value: vendorId }, APAccountRef: { value: apAccount.Id }, Line: poLines };

    if (oppIds.length === 1) {
      const [opp] = await sf.query(`
        SELECT Id, ${f.oppLid}, ${f.oppJobNumber} FROM Opportunity WHERE Id = '${esc(oppIds[0])}' LIMIT 1
      `);
      const cf = [];
      if (opp?.[f.oppLid]) cf.push({ DefinitionId: qcfg.poCustomFields.lid.definitionId, Name: qcfg.poCustomFields.lid.name, Type: 'StringType', StringValue: String(opp[f.oppLid]) });
      if (opp?.[f.oppJobNumber]) cf.push({ DefinitionId: qcfg.poCustomFields.jobWo.definitionId, Name: qcfg.poCustomFields.jobWo.name, Type: 'StringType', StringValue: String(opp[f.oppJobNumber]) });
      if (cf.length) body.CustomField = cf;
    }

    // Step 4 -- DocNumber, with one retry bumping past an apparent collision
    // (see nextDocNumber's comment for why this is safe).
    body.DocNumber = await nextDocNumber(qbo);
    let created;
    try {
      created = await qbo.create('purchaseorder', body);
    } catch (e) {
      if (!/duplicate|docnumber/i.test(e.message)) throw e;
      const [, yy, seq] = /^(\d{2})-(\d+)$/.exec(body.DocNumber);
      body.DocNumber = `${yy}-${String(parseInt(seq, 10) + 1).padStart(4, '0')}`;
      created = await qbo.create('purchaseorder', body);
    }
    // Step 5 -- mirror into Salesforce's "CRS Purchase Order" object
    // (Opportunity__c -- a different, unrelated custom object from the
    // standard Opportunity, confirmed live 2026-08-26 from a real example
    // record). One record per distinct Opportunity in this PO, sharing the
    // same CRS_PO_Number__c -- confirmed live this "one PO number split
    // across multiple job records" pattern already exists in real historical
    // data (e.g. "18-0342" on 6 real records). Best-effort and non-blocking:
    // the real QBO PO above is what actually matters and has already
    // succeeded, so a failure here is reported, not thrown.
    let sfWriteWarning = null;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const jobNumbers = new Map(); // opportunityId -> Job__c (WO#)
      const oppRows = await sf.query(`
        SELECT Id, ${f.oppJobNumber} FROM Opportunity WHERE Id IN (${oppIds.map((id) => `'${esc(id)}'`).join(',')})
      `);
      for (const r of oppRows) jobNumbers.set(r.Id, r[f.oppJobNumber] ?? null);

      for (const oppId of oppIds) {
        const oppLines = clean.filter((l) => l.opportunityId === oppId);
        const amount = oppLines.reduce((s, l) => s + Number(l.quantity) * Number(l.unitCost || 0), 0);
        await sf.createRecord('Opportunity__c', {
          Opportunity_Name__c: oppId, // the real, populated relationship field -- NOT Opportunity__c itself (confirmed live: 87% vs 0.7% populated)
          CRS_PO_Number__c: created.DocNumber,
          Purchase_Order_Amount__c: amount,
          ...(sfdcVendorId ? { CRS_Vendor__c: sfdcVendorId } : {}), // NOT Vendor__c -- confirmed live 0% populated, CRS_Vendor__c is the real field
          // Required by a hard SF validation rule (found live 2026-08-21 --
          // not just a nice-to-have): "Required fields are missing:
          // [Cost_Center__c]" on create if omitted.
          ...(costCenterId ? { Cost_Center__c: costCenterId } : {}),
          Status__c: 'Purchase Order Executed',
          PO_Sign_Date__c: today,
          ...(jobNumbers.get(oppId) ? { Job_No__c: jobNumbers.get(oppId) } : {}),
        });
      }
    } catch (e) {
      sfWriteWarning = `PO created in QuickBooks, but the Salesforce "CRS Purchase Order" mirror record failed: ${e.message}`;
    }

    return c.json({ id: created.Id, docNumber: created.DocNumber, sfWriteWarning });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
