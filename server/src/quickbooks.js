// QuickBooks Online API client - mirrors the pattern in salesforce.js / fieldSquared.js.
//
// Env vars required:
//   QBO_CLIENT_ID, QBO_CLIENT_SECRET - OAuth2 app credentials
//   QBO_REALM_ID                      - the company Id (every API call is scoped to it)
//   QBO_REFRESH_TOKEN                 - BOOTSTRAP only; the live (rotating) refresh token is
//                                       kept in KV once minted. Seed value on first run.
// KV binding:
//   SF_TOKENS - reused to persist the rotating refresh token + cache the access token.
//
// QBO has no client-credentials flow: access is via the OAuth2 refresh_token grant. The
// refresh token ROTATES (Intuit may hand back a new one on any refresh, 100-day life, ~24h
// overlap), so it MUST be persisted durably - a Worker isolate's memory is not enough. We
// also single-flight the refresh so a burst of admin loads doesn't fire concurrent exchanges.

const OAUTH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const KV_REFRESH = 'qbo_refresh';   // the rotating refresh token (source of truth once seeded)
const KV_ACCESS = 'qbo_access';     // cached access token { token, expires }

// Per-isolate caches. `refreshing` is the single-flight guard.
let mem = { token: null, expires: 0 };
let refreshing = null;

export function createQbo(env) {
  const KV = env.SF_TOKENS;
  const realm = env.QBO_REALM_ID;
  if (!realm) throw new Error('Missing QBO_REALM_ID');
  if (!env.QBO_CLIENT_ID || !env.QBO_CLIENT_SECRET) throw new Error('Missing QBO_CLIENT_ID / QBO_CLIENT_SECRET');

  // ---- Auth --------------------------------------------------------------
  async function doRefresh() {
    // Prefer the KV-stored (rotated) refresh token; fall back to the bootstrap secret.
    const stored = KV ? await KV.get(KV_REFRESH) : null;
    const refreshToken = stored || env.QBO_REFRESH_TOKEN;
    if (!refreshToken) throw new Error('No QBO refresh token (KV empty and QBO_REFRESH_TOKEN unset)');

    const basic = btoa(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`);
    const res = await fetch(OAUTH_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`QBO token refresh failed: ${res.status} ${text}`);
    const data = JSON.parse(text);

    // Persist the (possibly rotated) refresh token BEFORE anything else - losing it locks us out.
    if (KV && data.refresh_token && data.refresh_token !== refreshToken) {
      await KV.put(KV_REFRESH, data.refresh_token);
    } else if (KV && data.refresh_token && !stored) {
      // First run: move the bootstrap value into KV so it becomes the source of truth.
      await KV.put(KV_REFRESH, data.refresh_token);
    }

    const ttlMs = Math.max(60, (data.expires_in || 3600) - 120) * 1000; // small safety margin
    mem = { token: data.access_token, expires: Date.now() + ttlMs };
    if (KV) await KV.put(KV_ACCESS, JSON.stringify(mem), { expirationTtl: Math.floor(ttlMs / 1000) });
    return mem.token;
  }

  async function getToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && mem.token && now < mem.expires) return mem.token;
    if (!forceRefresh && KV) {
      const hit = await KV.get(KV_ACCESS, 'json');
      if (hit && now < hit.expires) { mem = hit; return mem.token; }
    }
    // Single-flight: collapse concurrent refreshes into one token exchange.
    if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  // ---- Raw query with one 401 retry -------------------------------------
  async function runQuery(soql, retried = false) {
    const token = await getToken(retried);
    const res = await fetch(`${API_BASE}/v3/company/${realm}/query?query=${encodeURIComponent(soql)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (res.status === 401 && !retried) return runQuery(soql, true);
    const text = await res.text();
    if (!res.ok) throw new Error(`QBO query failed: ${res.status} ${text.slice(0, 400)}`);
    return (JSON.parse(text).QueryResponse) || {};
  }

  // ---- Raw create (POST) with one 401 retry ------------------------------
  // `entity` is the lowercase QBO endpoint segment, e.g. 'purchaseorder', 'customer'
  // (NOT the capitalized query-language name used in runQuery/queryAll).
  async function runCreate(entity, body, retried = false) {
    const token = await getToken(retried);
    const res = await fetch(`${API_BASE}/v3/company/${realm}/${entity}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401 && !retried) return runCreate(entity, body, true);
    const text = await res.text();
    if (!res.ok) throw new Error(`QBO create ${entity} failed: ${res.status} ${text.slice(0, 800)}`);
    const json = JSON.parse(text);
    // QBO's envelope key isn't a plain capitalize-first-letter of `entity` --
    // confirmed live: 'purchaseorder' comes back as "PurchaseOrder", not
    // "Purchaseorder". Match case-insensitively instead of guessing the scheme.
    const key = Object.keys(json).find((k) => k.toLowerCase() === entity.toLowerCase());
    return key ? json[key] : json;
  }

  return {
    getToken,
    // Single-page query. Returns the QueryResponse object ({ Invoice: [...], totalCount, ... }).
    query: (soql) => runQuery(soql),
    // Creates a record. entity: lowercase endpoint segment (e.g. 'purchaseorder', 'customer').
    // Returns the created entity object (unwrapped from QBO's { PurchaseOrder: {...} } envelope).
    create: (entity, body) => runCreate(entity, body),
    // Paginated fetch of one entity. `entity` e.g. 'Invoice'; `whereAndOrder` is the text after
    // `SELECT * FROM <entity> ` (a WHERE and/or ORDERBY). Returns all rows across pages.
    async queryAll(entity, whereAndOrder = '') {
      const out = [];
      let start = 1;
      const PAGE = 1000; // QBO max
      for (;;) {
        const soql = `SELECT * FROM ${entity} ${whereAndOrder} STARTPOSITION ${start} MAXRESULTS ${PAGE}`.replace(/\s+/g, ' ').trim();
        const qr = await runQuery(soql);
        const rows = qr[entity] || [];
        out.push(...rows);
        if (rows.length < PAGE) break;
        start += PAGE;
      }
      return out;
    },
  };
}
