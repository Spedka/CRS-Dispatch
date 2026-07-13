// Mints chalkboard magic links from crs-dispatch, without touching the
// chalkboard repo — this independently computes the same bespoke two-part
// token the chalkboard's own worker/src/auth.ts verifies, using a copy of
// the same AUTH_SECRET. Token format: <base64url(payload JSON)>.<base64url(
// HMAC-SHA256 signature of that base64url-encoded payload STRING, not the
// raw JSON)>. No JWT header segment, no alg negotiation.

const DEV_FALLBACK_SECRET = 'chalkboard-dev-insecure-secret-do-not-use-in-prod';
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

function base64url(bytes) {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncodeString(str) {
  return base64url(new TextEncoder().encode(str));
}

let warnedDevSecret = false;
function getAuthSecret(env) {
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  if (!warnedDevSecret) {
    console.warn('[authLink] AUTH_SECRET not set — using insecure dev fallback. Set via `wrangler secret put AUTH_SECRET` (same value as the chalkboard worker) before relying on this in production.');
    warnedDevSecret = true;
  }
  return DEV_FALLBACK_SECRET;
}

async function signPayload(env, payload) {
  const encodedPayload = base64urlEncodeString(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getAuthSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload));
  return `${encodedPayload}.${base64url(sig)}`;
}

// name must be the technician's exact Technician__c.Name — that's the only
// identity the chalkboard side checks, so it's resolved server-side from the
// technicianId rather than trusted as free text from the client.
export async function mintMagicLink(env, name) {
  const exp = Date.now() + MAGIC_LINK_TTL_MS;
  const token = await signPayload(env, { kind: 'magic', name, exp });
  const appUrl = (env.CHALKBOARD_APP_URL || 'https://chalkboard.crsbas.workers.dev').replace(/\/+$/, '');
  return { link: `${appUrl}/?token=${token}`, expiresAt: exp };
}
