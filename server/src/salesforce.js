import { config } from './config.js';

// Per-isolate cache (warm isolates reuse it across requests).
let mem = { token: null, instanceUrl: null, expires: 0 };

export function createSalesforce(env) {
  const KV = env.SF_TOKENS; // optional second layer

  async function getToken() {
    const now = Date.now();
    if (mem.token && now < mem.expires) return mem;

    if (KV) {
      const hit = await KV.get('sf_token', 'json');
      if (hit && now < hit.expires) { mem = hit; return mem; }
    }

    const loginUrl = env.SF_LOGIN_URL || 'https://login.salesforce.com';
    const clientId = env.SF_CLIENT_ID;
    const clientSecret = env.SF_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('Missing SF_CLIENT_ID / SF_CLIENT_SECRET');
    }

    const base = loginUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Salesforce auth failed: ${res.status} ${await res.text()}`);

    const data = await res.json();
    mem = {
      token: data.access_token,
      instanceUrl: data.instance_url,
      expires: Date.now() + 30 * 60 * 1000,
    };
    if (KV) await KV.put('sf_token', JSON.stringify(mem), { expirationTtl: 1800 });
    return mem;
  }

  async function sfFetch(path, options = {}) {
    const { token, instanceUrl } = await getToken();
    return fetch(`${instanceUrl}/services/data/${config.salesforce.apiVersion}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  }

  return {
    async query(soql) {
      const res = await sfFetch(`/query?q=${encodeURIComponent(soql)}`);
      if (!res.ok) throw new Error(`SOQL failed: ${res.status} ${await res.text()}`);
      return (await res.json()).records;
    },
    async createRecord(object, fields) {
      const res = await sfFetch(`/sobjects/${object}`, { method: 'POST', body: JSON.stringify(fields) });
      if (!res.ok) throw new Error(`Create failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async deleteRecord(object, id) {
      const res = await sfFetch(`/sobjects/${object}/${id}`, { method: 'DELETE' });
      if (res.status !== 204) throw new Error(`Delete failed: ${res.status} ${await res.text()}`);
      return { success: true };
    },
    async updateRecord(object, id, fields) {
      const res = await sfFetch(`/sobjects/${object}/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
      if (res.status !== 204) throw new Error(`Update failed: ${res.status} ${await res.text()}`);
      return { success: true };
    },
  };
}