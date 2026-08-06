import { Hono } from 'hono';
import { config } from './config.js';
import { createSalesforce } from './salesforce.js';
import { esc } from './assignments.js';

const f = config.fields;
const inv = config.inventory;
const chk = config.checkout;
const prod = config.product;

function shapeInventoryRow(r) {
  return {
    id: r.Id,
    productId: r[inv.product],
    productName: r[inv.productRelationship]?.Name ?? null,
    productCode: r[inv.productRelationship]?.[prod.code] ?? null,
    quantity: r[inv.quantity] ?? 0,
    price: r[inv.price] ?? null,
    poNumber: r[inv.poNumber] ?? null,
    poUploaded: r[inv.poUploaded] === true,
    lastModifiedDate: r.LastModifiedDate ?? null,
  };
}

// Shared by both batch endpoints below: finds the Available_Inventory__c row
// for this exact Opportunity+Product pair and adjusts its Quantity__c by
// `delta` -- creates a new row (starting from 0 + delta) if none exists yet,
// rather than silently skipping. Deliberately the SAME function for both
// directions: Add Inventory calls it with delta = +quantity (upsert-and-add),
// Part Checkout calls it with delta = -quantity (decrement-or-create-negative)
// -- symmetric by design, not two parallel implementations that could drift.
//
// `headerFields` apply on BOTH create and update (e.g. PO_Number__c/
// PO_Uploaded__c on an Add Inventory write, or Price__c refreshing on every
// Add Inventory touch). `createOnlyFields` apply ONLY when a new row is
// created -- used by Checkout's deficit-row edge case (a product checked out
// with no prior Available_Inventory__c row) to satisfy Price__c's live
// required-field validation rule without re-stamping price on a plain
// decrement of an existing row, which should stay Add-Inventory's job alone.
async function adjustInventory(sf, oppId, productId, delta, headerFields = {}, createOnlyFields = {}) {
  const existing = await sf.query(
    `SELECT Id, ${inv.quantity} FROM ${inv.sobject}
     WHERE ${inv.opportunity} = '${esc(oppId)}' AND ${inv.product} = '${esc(productId)}' LIMIT 1`
  );
  if (existing[0]) {
    const newQty = (existing[0][inv.quantity] ?? 0) + delta;
    await sf.updateRecord(inv.sobject, existing[0].Id, { [inv.quantity]: newQty, ...headerFields });
    return { id: existing[0].Id, created: false, quantity: newQty };
  }
  const created = await sf.createRecord(inv.sobject, {
    [inv.opportunity]: oppId,
    [inv.product]: productId,
    [inv.quantity]: delta,
    ...headerFields,
    ...createOnlyFields,
  });
  return { id: created.id, created: true, quantity: delta };
}

// Product2 + Standard Price Book catalog, merged client-side by Product2Id
// (this app's established grouping convention -- flat queries, no subquery).
// Product2 has no price field of its own; UnitPrice lives on PricebookEntry.
async function fetchCatalog(sf) {
  const products = await sf.query(
    `SELECT Id, ${prod.name}, ${prod.code}, ${prod.description}
     FROM ${prod.sobject} WHERE IsActive = true ORDER BY ${prod.name}`
  );
  const entries = await sf.query(
    `SELECT Product2Id, UnitPrice FROM PricebookEntry
     WHERE Pricebook2Id IN (SELECT Id FROM Pricebook2 WHERE IsStandard = true) AND IsActive = true`
  );
  const priceByProductId = new Map(entries.map((e) => [e.Product2Id, e.UnitPrice]));
  return products.map((p) => ({
    id: p.Id,
    name: p[prod.name],
    code: p[prod.code] ?? null,
    description: p[prod.description] ?? null,
    price: priceByProductId.get(p.Id) ?? null,
  }));
}

// Scoped price + record-name lookup for just the products a write touches.
// Price__c is a required field on Available_Inventory__c (a live validation
// rule blocks blank/null, confirmed against the org; 0 satisfies it fine), so
// every create/update through adjustInventory() must supply a real number --
// products with no Standard Price Book entry get 0, not null. Separately,
// Available_Inventory__c's own Name field should read as the part # (falling
// back to the product's full name if it has no ProductCode) rather than the
// default record Id, so list views/reports in Salesforce are identifiable at
// a glance -- truncated to 80 chars, the standard custom-object Name limit.
async function getProductInfoFor(sf, productIds) {
  const map = new Map();
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return map;
  const idList = ids.map((id) => `'${esc(id)}'`).join(',');

  const products = await sf.query(
    `SELECT Id, ${prod.name}, ${prod.code} FROM ${prod.sobject} WHERE Id IN (${idList})`
  );
  for (const p of products) {
    const label = p[prod.code] || p[prod.name] || '';
    map.set(p.Id, { price: 0, name: label.slice(0, 80) });
  }

  const entries = await sf.query(
    `SELECT Product2Id, UnitPrice FROM PricebookEntry
     WHERE Product2Id IN (${idList})
       AND Pricebook2Id IN (SELECT Id FROM Pricebook2 WHERE IsStandard = true) AND IsActive = true`
  );
  for (const e of entries) {
    const existing = map.get(e.Product2Id);
    if (existing) existing.price = e.UnitPrice ?? 0;
  }

  return map;
}

export const parts = new Hono();

// Grouped-by-Opportunity inventory list for the Parts tab. Queries flat (no
// SOQL subquery -- see invoicesByOppId/billingByLid in routes.js) and groups
// client-side in the Worker into a Map keyed by Opportunity__c, then returns
// the pre-grouped array directly. Service Stock is sorted first, everything
// else alphabetically -- inverse of the UNASSIGNED-pinned-last sort in
// App.jsx's AccountsTab.
parts.get('/parts/inventory', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const rows = await sf.query(`
      SELECT Id, ${inv.opportunity}, ${inv.opportunityRelationship}.Name, ${inv.opportunityRelationship}.${f.oppLid},
             ${inv.product}, ${inv.productRelationship}.Name, ${inv.productRelationship}.${prod.code},
             ${inv.quantity}, ${inv.price}, ${inv.poNumber}, ${inv.poUploaded}, LastModifiedDate
      FROM ${inv.sobject}
      ORDER BY ${inv.opportunityRelationship}.Name ASC, ${inv.productRelationship}.Name ASC
    `);

    const groups = new Map(); // Opportunity Id -> group
    for (const r of rows) {
      const oppId = r[inv.opportunity];
      if (!groups.has(oppId)) {
        groups.set(oppId, {
          opportunityId: oppId,
          opportunityName: r[inv.opportunityRelationship]?.Name ?? '(unknown opportunity)',
          opportunityLid: r[inv.opportunityRelationship]?.[f.oppLid] ?? null,
          isServiceStock: oppId === c.env.SERVICE_STOCK_OPPORTUNITY_ID,
          rows: [],
        });
      }
      groups.get(oppId).rows.push(shapeInventoryRow(r));
    }

    const list = [...groups.values()];
    list.sort((x, y) =>
      x.isServiceStock ? -1 : y.isServiceStock ? 1 : x.opportunityName.localeCompare(y.opportunityName)
    );
    return c.json(list);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Product2 + Standard Price Book typeahead source. KV-cached 30 min (reuses
// the SF_TOKENS binding, mirrors the FS user-roster cache pattern at
// routes.js's GET /fs-users) -- a parts catalog changes rarely and this app
// never writes to Product2, so a plain TTL is the only refresh mechanism
// needed, no invalidation hook required.
parts.get('/parts/catalog', async (c) => {
  try {
    const KV = c.env.SF_TOKENS;
    const CACHE_KEY = 'product2_catalog_v1';
    const CACHE_TTL = 1800;
    let products = KV ? await KV.get(CACHE_KEY, 'json') : null;
    if (!products) {
      const sf = createSalesforce(c.env);
      products = await fetchCatalog(sf);
      if (KV) await KV.put(CACHE_KEY, JSON.stringify(products), { expirationTtl: CACHE_TTL });
    }
    return c.json(products);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// The Service Stock sentinel's live Id/Name, for the Opportunity pickers to
// pin at the top -- resolved from SERVICE_STOCK_OPPORTUNITY_ID rather than a
// name match. Not sourced from the inventory groups above because Service
// Stock must be pickable even before it has any Available_Inventory__c rows
// (e.g. the very first Add Inventory ever run against it).
parts.get('/parts/service-stock', async (c) => {
  try {
    const id = c.env.SERVICE_STOCK_OPPORTUNITY_ID;
    if (!id) return c.json({ error: 'SERVICE_STOCK_OPPORTUNITY_ID not configured' }, 500);
    const sf = createSalesforce(c.env);
    const rows = await sf.query(`SELECT Id, ${f.oppName} FROM Opportunity WHERE Id = '${esc(id)}' LIMIT 1`);
    if (!rows[0]) return c.json({ error: 'Service Stock opportunity not found -- check SERVICE_STOCK_OPPORTUNITY_ID' }, 404);
    return c.json({ id: rows[0].Id, name: rows[0][f.oppName] });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Add Inventory -- one batch submission, PO_Number__c/PO_Uploaded__c apply
// once to every line. Sequential for-of loop of awaits, not Promise.all --
// same convention as the fs-link sync-missing-assignments loop in routes.js:
// if one line throws, the lines before it have already committed and are NOT
// rolled back (this app's no-rollback convention throughout, e.g. the FS
// write-through path) -- the frontend re-fetches GET /parts/inventory
// afterward regardless, so displayed state is always correct either way.
//
// Request:  { opportunityId, poNumber?, poUploaded?, lines: [{ productId, quantity }, ...] }
// Response: { ok: true, results: [{ productId, id, created, quantity }, ...] }
parts.post('/parts/inventory', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const { opportunityId, poNumber, poUploaded, lines } = await c.req.json();
    if (!opportunityId) return c.json({ error: 'opportunityId required' }, 400);
    const clean = Array.isArray(lines) ? lines.filter((l) => l?.productId && Number(l.quantity) > 0) : [];
    if (clean.length === 0) return c.json({ error: 'At least one product + quantity line is required' }, 400);

    // PO_Number__c/PO_Uploaded__c are written onto every row this batch
    // touches, create OR update -- the most recent submission's values win.
    // PO_Number__c is required by a live validation rule (blank/null is
    // rejected on both insert and update) -- "N/A" stands in for "no PO
    // given" so the field stays effectively optional from the UI's
    // perspective without tripping that rule.
    const headerFields = { [inv.poNumber]: (poNumber && poNumber.trim()) || 'N/A' };
    if (poUploaded !== undefined) headerFields[inv.poUploaded] = !!poUploaded;

    // Price__c is required (live validation rule) -- scoped lookup per the
    // products in this batch, defaulting to 0 for anything with no Standard
    // Price Book entry. Name is set to the part # (falling back to the
    // product's name) so the record reads sensibly in Salesforce list views
    // instead of showing its raw Id. Both vary per line (unlike the header
    // fields above), so they're merged into each line's own field set.
    const productInfo = await getProductInfoFor(sf, clean.map((l) => l.productId));

    const results = [];
    for (const line of clean) {
      const info = productInfo.get(line.productId);
      const lineFields = { ...headerFields, [inv.price]: info?.price ?? 0, Name: info?.name || line.productId };
      const r = await adjustInventory(sf, opportunityId, line.productId, Number(line.quantity), lineFields);
      results.push({ productId: line.productId, ...r });
    }
    return c.json({ ok: true, results });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Part Checkout -- one batch submission: header fields (Opportunity,
// Checked_Out_By__c, Checkout_Date__c, Material_Request_Number__c,
// Material_Req_Attached__c) apply once; Product__c/Quantity__c/
// Flagged_For_Review__c vary per line. Each line, in order: (1) resolves or
// creates the Available_Inventory__c row via adjustInventory() and
// decrements it first, (2) creates the Part_Checkout__c row in a single call
// with Inventory__c already pointing at that row's Id -- no follow-up patch,
// no window where the reference is unset. materialReqAttached is enforced
// here as ordinary API input validation (matches this app's existing
// required-field checks) -- this is NOT Salesforce-level enforcement, there
// is still no SF validation rule/Flow.
//
// Request:  { opportunityId, checkedOutById, checkoutDate, truckNumber, materialRequestNumber,
//             materialReqAttached, lines: [{ productId, quantity, flaggedForReview? }, ...] }
// Response: { ok: true, results: [{ productId, checkoutId, inventory: {id, created, quantity} }, ...] }
parts.post('/parts/checkout', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const { opportunityId, checkedOutById, checkoutDate, truckNumber, materialRequestNumber, materialReqAttached, lines } =
      await c.req.json();
    if (!opportunityId) return c.json({ error: 'opportunityId required' }, 400);
    if (!checkedOutById) return c.json({ error: 'checkedOutById required' }, 400);
    if (!checkoutDate) return c.json({ error: 'checkoutDate required' }, 400);
    if (!truckNumber || !truckNumber.trim()) return c.json({ error: 'truckNumber required' }, 400);
    if (!materialRequestNumber || !materialRequestNumber.trim()) return c.json({ error: 'materialRequestNumber required' }, 400);
    if (!materialReqAttached) return c.json({ error: 'materialReqAttached must be checked before submitting' }, 400);
    const clean = Array.isArray(lines) ? lines.filter((l) => l?.productId && Number(l.quantity) > 0) : [];
    if (clean.length === 0) return c.json({ error: 'At least one product + quantity line is required' }, 400);

    const checkoutFields = {
      [chk.opportunity]: opportunityId,
      [chk.checkedOutBy]: checkedOutById,
      [chk.checkoutDate]: checkoutDate,
      [chk.truckNumber]: truckNumber.trim(),
      [chk.materialRequestNumber]: materialRequestNumber.trim(),
      [chk.materialReqAttached]: true,
    };

    // Price__c and PO_Number__c are both required by a live validation rule
    // on Available_Inventory__c -- only matters if this checkout is the very
    // first touch on this Opportunity+Product pair, in which case
    // adjustInventory() has to create the row from scratch. createOnlyFields
    // (not headerFields) so a plain decrement of an existing row never
    // re-stamps its price, name, or PO reference -- those stay Add
    // Inventory's job alone. Checkout has no PO Number concept at all, so a
    // deficit-row create always gets the "N/A" placeholder, same as Add
    // Inventory's own blank-PO case.
    const productInfo = await getProductInfoFor(sf, clean.map((l) => l.productId));

    const results = [];
    for (const line of clean) {
      const info = productInfo.get(line.productId);
      const invResult = await adjustInventory(
        sf, opportunityId, line.productId, -Number(line.quantity),
        {}, { [inv.price]: info?.price ?? 0, [inv.poNumber]: 'N/A', Name: info?.name || line.productId }
      );
      const created = await sf.createRecord(chk.sobject, {
        ...checkoutFields,
        [chk.product]: line.productId,
        [chk.quantity]: Number(line.quantity),
        [chk.flaggedForReview]: !!line.flaggedForReview,
        [chk.inventory]: invResult.id,
      });
      results.push({ productId: line.productId, checkoutId: created.id, inventory: invResult });
    }
    return c.json({ ok: true, results });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Inline single-row quantity edit (the list's "edit directly" alternative to
// the Add Inventory modal) -- a direct SET of the typed value, distinct from
// adjustInventory()'s delta-add logic used by the two batch endpoints above.
parts.patch('/parts/inventory/:id', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param('id');
    const { quantity } = await c.req.json();
    if (quantity === undefined || quantity === null || Number.isNaN(Number(quantity))) {
      return c.json({ error: 'quantity required' }, 400);
    }
    await sf.updateRecord(inv.sobject, id, { [inv.quantity]: Number(quantity) });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
