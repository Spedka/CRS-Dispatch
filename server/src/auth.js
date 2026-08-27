// Dispatch (office) auth: /api/auth/login (email + password) issues a long-lived
// device token that the frontend stores and sends as `Authorization: Bearer
// <deviceToken>`. Ported from crs-board's worker/src/auth.ts - same stateless,
// self-verifying HMAC approach (no server-side session storage; a Worker runs
// many isolates, so an in-memory session map would only exist on one of them).
//
// The device token carries only the user's Name; the ADMIN role is never
// trusted from the token - admin-gated routes re-read User.Dispatch_Admin__c
// live from Salesforce (see routes.js), so revoking admin takes effect at once.

const DEV_FALLBACK_SECRET = 'dispatch-dev-insecure-secret-do-not-use-in-prod';
let warnedMissingSecret = false;

export function getAuthSecret(env) {
  const secret = env?.AUTH_SECRET;
  if (secret) return secret;
  if (!warnedMissingSecret) {
    console.warn('AUTH_SECRET not set - dispatch auth tokens use an insecure dev fallback. Set it via `wrangler secret put AUTH_SECRET` before deploying.');
    warnedMissingSecret = true;
  }
  return DEV_FALLBACK_SECRET;
}

const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromBase64Url = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

const hmacKey = (secret) =>
  crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

async function sign(payload, secret) {
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(encoded));
  return `${encoded}.${toBase64Url(new Uint8Array(sig))}`;
}

async function verify(token, secret) {
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return undefined;
  try {
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64Url(sig), new TextEncoder().encode(encoded));
    if (!valid) return undefined;
    return JSON.parse(new TextDecoder().decode(fromBase64Url(encoded)));
  } catch {
    return undefined;
  }
}

export function signDeviceToken(name, secret) {
  return sign({ kind: 'device', name }, secret);
}

// Returns the office user's Name if the token is a valid device token, else undefined.
export async function resolveDeviceToken(token, secret) {
  const payload = await verify(token, secret);
  return payload?.kind === 'device' ? payload.name : undefined;
}

// Convenience: pull + resolve the bearer name from a request's Authorization
// header. Returns undefined when absent/invalid.
export async function resolveBearer(c) {
  const bearer = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return undefined;
  return resolveDeviceToken(bearer, getAuthSecret(c.env));
}
