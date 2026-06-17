import { config } from './config.js';

// Server-to-server auth using the Client Credentials flow (same approach
// as your QBO pipeline). Token is cached and refreshed on an interval so
// we're not hitting the token endpoint on every request.

let cached = { token: null, instanceUrl: null, expires: 0 };

async function getToken() {
  if (cached.token && Date.now() < cached.expires) return cached;

  const { loginUrl, clientId, clientSecret } = config.salesforce;
  if (!clientId || !clientSecret) {
    throw new Error('Missing SF_CLIENT_ID / SF_CLIENT_SECRET in .env');
  }

  // Strip any trailing slash so we never build a double-slash token URL.
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

  if (!res.ok) {
    throw new Error(`Salesforce auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cached = {
    token: data.access_token,
    instanceUrl: data.instance_url,
    expires: Date.now() + 30 * 60 * 1000, // refresh every 30 min
  };
  return cached;
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

export async function query(soql) {
  const res = await sfFetch(`/query?q=${encodeURIComponent(soql)}`);
  if (!res.ok) throw new Error(`SOQL failed: ${res.status} ${await res.text()}`);
  return (await res.json()).records;
}

export async function createRecord(object, fields) {
  const res = await sfFetch(`/sobjects/${object}`, {
    method: 'POST',
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`Create failed: ${res.status} ${await res.text()}`);
  return res.json(); // { id, success, errors }
}

export async function deleteRecord(object, id) {
  const res = await sfFetch(`/sobjects/${object}/${id}`, { method: 'DELETE' });
  // Salesforce returns 204 No Content on a successful delete.
  if (res.status !== 204) throw new Error(`Delete failed: ${res.status} ${await res.text()}`);
  return { success: true };
}

export async function updateRecord(object, id, fields) {
  const res = await sfFetch(`/sobjects/${object}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
  // A successful update also returns 204 No Content.
  if (res.status !== 204) throw new Error(`Update failed: ${res.status} ${await res.text()}`);
  return { success: true };
}