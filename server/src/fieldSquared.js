// FS API client — mirrors the pattern in salesforce.js
// Env vars required:
//   FS_EMAIL        — API account email
//   FS_PASSWORD     — API account password
//   FS_WORKSPACE    — numeric workspace ID (e.g. "123")
// KV binding:
//   FS_TOKENS       — same Workers KV namespace used to cache the auth token

const FS_BASE = 'https://api.fieldsquared.com';

// Per-isolate in-memory cache — warm isolates reuse across requests.
let mem = { token: null, expires: 0 };

export function createFs(env) {
  const KV = env.FS_TOKENS;
  const workspace = env.FS_WORKSPACE;

  if (!workspace) throw new Error('Missing FS_WORKSPACE env var');
  if (!env.FS_EMAIL || !env.FS_PASSWORD) throw new Error('Missing FS_EMAIL / FS_PASSWORD env vars');

  // ---- Auth ----------------------------------------------------------------
  // IMPORTANT: calling /Authentication again issues a NEW token and immediately
  // invalidates any previously issued token. Never call speculatively — only on
  // confirmed 401 or cold start.
  async function fetchNewToken() {
    const res = await fetch(`${FS_BASE}/Authentication`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ Email: env.FS_EMAIL, Password: env.FS_PASSWORD }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`FS auth failed: ${res.status} ${text}`);
    const data = JSON.parse(text);
    return data.AuthToken;
  }

  async function getToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && mem.token && now < mem.expires) return mem.token;

    if (!forceRefresh && KV) {
      const hit = await KV.get('fs_token', 'json');
      if (hit && now < hit.expires) {
        mem = hit;
        return mem.token;
      }
    }

    const token = await fetchNewToken();
    mem = { token, expires: now + 55 * 60 * 1000 }; // treat as ~55 min
    if (KV) await KV.put('fs_token', JSON.stringify(mem), { expirationTtl: 3300 });
    return token;
  }

  // ---- Raw fetch with auto-retry on 401 ------------------------------------
  async function fsFetch(path, options = {}, retried = false) {
    const token = await getToken();
    const res = await fetch(`${FS_BASE}/${workspace}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Workspace': workspace,
        'X-Auth-Token': token,
        'X-Client': '3',
        ...(options.headers || {}),
      },
    });

    // FS invalidates tokens on re-auth, so only retry once to avoid a loop.
    if (res.status === 401 && !retried) {
      mem = { token: null, expires: 0 };
      if (KV) await KV.delete('fs_token');
      return fsFetch(path, options, true);
    }

    return res;
  }

  // ---- Public API ----------------------------------------------------------

  /**
   * Fetch a single task by ExternalId (full record including Users array).
   * Uses the /Task/{id} endpoint the FS web app itself uses — returns more
   * detail than the list endpoint.
   */
  async function getTask(externalId) {
    const res = await fsFetch(`/Task/${externalId}`);
    if (!res.ok) throw new Error(`FS getTask failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /**
   * List tasks modified since a given ISO date string.
   * Returns the compact list shape (User singular, not Users array).
   * Use getTask() to get the full record for any individual task.
   *
   * @param {string} since  — ISO 8601 UTC string, e.g. "2026-06-22T00:00:00Z"
   * @param {string} [taskType] — optional taskType filter (must be single type per FS docs)
   */
  async function listModified(since, taskType) {
    let qs = `modifiedsince=${since}`;
    if (taskType) qs += `&tasktypes=${encodeURIComponent(taskType)}`;
    const res = await fsFetch(`/api/task?${qs}`);
    if (!res.ok) throw new Error(`FS listModified failed: ${res.status} ${await res.text()}`);
    return res.json(); // array of task objects
  }

  /**
   * Update a task's status (and any other top-level fields).
   * Name and TaskType are required by FS even for partial updates.
   */
  async function updateStatus(externalId, name, taskType, status) {
    const res = await fsFetch(`/api/task/${externalId}`, {
      method: 'POST',
      body: JSON.stringify({ Name: name, TaskType: taskType, Status: status }),
    });
    // FS always returns 200 — real errors are in x-errorstatusmessage, not the status code.
    const errHeader = res.headers.get('x-errorstatusmessage');
    if (errHeader) throw new Error(errHeader);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return true;
  }

  return { getToken, getTask, listModified, updateStatus };
}