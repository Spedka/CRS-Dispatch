// Shared QBO helpers used by both purchaseOrders.js and invoices.js -- item
// matching/caching and (new, for invoices) per-technician labor-item
// matching. Factored out of purchaseOrders.js so the two features don't
// carry two divergent copies of the same matching logic.

import { createQbo } from './quickbooks.js';

// Cached, usable QBO Items -- "usable" means excluding Type:'Category' (a
// grouping header, not a real line item -- confirmed live 2026-08-21: this
// company has a "Parts" Item that's exactly this, Category with no account,
// and creating a PurchaseOrder line against it fails: "Select an account for
// this transaction") and requiring an ExpenseAccountRef, so every Item this
// endpoint returns is guaranteed to work as an ItemBasedExpenseLineDetail line.
// KV-cached (~30m), same pattern as /parts/catalog.
export async function getUsableItems(env) {
  const KV = env.SF_TOKENS;
  const CACHE_KEY = 'qbo_items_v1';
  const CACHE_TTL = 1800;
  let items = KV ? await KV.get(CACHE_KEY, 'json') : null;
  if (!items) {
    const qbo = createQbo(env);
    const rows = await qbo.queryAll('Item');
    items = rows
      .filter((i) => i.Type !== 'Category' && i.ExpenseAccountRef && i.Active !== false)
      .map((i) => ({
        id: i.Id,
        name: i.Name,
        sku: i.Sku || null,
        description: i.Description || null,
        unitPrice: i.UnitPrice ?? null,
      }));
    if (KV) await KV.put(CACHE_KEY, JSON.stringify(items), { expirationTtl: CACHE_TTL });
  }
  return items;
}

export async function invalidateItemsCache(env) {
  if (env.SF_TOKENS) await env.SF_TOKENS.delete('qbo_items_v1');
}

// Cached, usable QBO Items for SALES lines (invoices.js) -- a SEPARATE list
// from getUsableItems() above, which is purchase-oriented (requires
// ExpenseAccountRef). Confirmed live 2026-08-25 this company's real labor/
// service catalog is largely income-only: "Fire Alarm - Wyatt, J. - Lead T"
// and "Truck Charges" both have an IncomeAccountRef and NO ExpenseAccountRef
// at all -- getUsableItems()'s filter silently excluded every real tech
// labor item and Truck Charges itself, leaving only the handful of items
// (like "Helper", which happens to carry both refs) that passed. Requires
// IncomeAccountRef instead. Separate KV cache key so the two lists don't
// collide or overwrite each other.
export async function getSalesItems(env) {
  const KV = env.SF_TOKENS;
  const CACHE_KEY = 'qbo_sales_items_v1';
  const CACHE_TTL = 1800;
  let items = KV ? await KV.get(CACHE_KEY, 'json') : null;
  if (!items) {
    const qbo = createQbo(env);
    const rows = await qbo.queryAll('Item');
    items = rows
      .filter((i) => i.Type !== 'Category' && i.IncomeAccountRef && i.Active !== false)
      .map((i) => ({
        id: i.Id,
        name: i.Name,
        sku: i.Sku || null,
        description: i.Description || null,
        unitPrice: i.UnitPrice ?? null,
        // Real Items in this company file have no SalesTaxCodeRef field at
        // all (confirmed live 2026-08-25) -- just a plain Taxable boolean.
        // taxCodeRef below derives QBO's literal 'TAX'/'NON' short codes from
        // it, matching what real sent invoices actually carry per line.
        taxable: i.Taxable ?? null,
      }));
    if (KV) await KV.put(CACHE_KEY, JSON.stringify(items), { expirationTtl: CACHE_TTL });
  }
  return items;
}

export async function invalidateSalesItemsCache(env) {
  if (env.SF_TOKENS) await env.SF_TOKENS.delete('qbo_sales_items_v1');
}

// Exact, case-insensitive match of a Salesforce Product2's SKU (ProductCode)
// against a QBO Item's Name or Sku -- confirmed live 2026-08-21: this
// company's QBO Items are largely real per-part records (names like
// "FSP-951-BP" matching a vendor part number directly), not a coarse
// category catalog as first assumed, and ProductCode matches an Item by name
// exactly 78.8% of the time on a real recent sample. Falls back to matching
// on the product's Name only if the code itself doesn't hit (rare, but
// covers a few catalog entries with no ProductCode at all).
export function matchItem(items, code, name) {
  const norm = (s) => (s || '').trim().toLowerCase();
  const nCode = norm(code);
  const nName = norm(name);
  if (nCode) {
    const hit = items.find((i) => norm(i.name) === nCode || norm(i.sku) === nCode);
    if (hit) return hit;
  }
  if (nName) {
    const hit = items.find((i) => norm(i.name) === nName);
    if (hit) return hit;
  }
  return null;
}

// Per-technician labor Item matcher, for invoices.js -- this company's real
// QBO Item catalog has a per-employee "Fire Alarm - Lastname, F." entry for
// most techs (e.g. "Fire Alarm - Wyatt, J. - Lead T", "Fire Alarm -
// Ellenburg, M."), confirmed live against 13 real sent invoices spanning
// ~10 distinct techs. Two confirmed exceptions to the convention, also from
// live invoices:
//   - Skip Cashion's item uses his full first name ("Fire Alarm - Cashion,
//     Skip"), not an initial -- he's a co-founder, a one-off.
//   - One item, "Elijah Boyarskiy", breaks the convention entirely: full
//     name, no "Fire Alarm -" prefix, no lastname-first ordering.
// So this tries, in order: (1) the "Lastname, F." convention as a
// substring match (catches both the plain and "- Lead T"/"- Lead" variants
// and the Cashion full-first-name exception, since substring matching on
// "Cashion, Skip" still finds "Fire Alarm - Cashion, Skip"), (2) the literal
// full name as a substring match (catches Boyarskiy-style off-convention
// entries), (3) null -- caller falls back to a generic Item (e.g. "Helper").
// Never auto-commits -- same suggest-only rule as matchItem() above; the
// frontend always shows what matched and lets the office override it.
export function matchTechItem(items, fsUserFullName) {
  const name = (fsUserFullName || '').trim();
  if (!name) return null;

  const parts = name.split(/\s+/);
  if (parts.length >= 2) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    const conventionForm = `${last}, ${first[0]}.`.toLowerCase();
    const hit = items.find((i) => (i.name || '').toLowerCase().includes(conventionForm));
    if (hit) return hit;
  }

  // Off-convention fallback: literal full name as a substring (e.g. "Elijah Boyarskiy").
  const nName = name.toLowerCase();
  const litHit = items.find((i) => (i.name || '').toLowerCase().includes(nName));
  if (litHit) return litHit;

  return null;
}
