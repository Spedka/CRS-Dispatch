// Pushes a live "refresh" to a tech's open chalkboard tab the moment we
// save a change that affects them. Fire-and-forget: a delivery failure here
// must never break the caller's own successful Salesforce write, so this
// mirrors the try/catch-and-log-don't-throw convention already used around
// the Field Squared calls in assignments.js/routes.js.
export async function notifyTech(env, techName, reason) {
  if (!techName) return;
  if (!env.BOARD) {
    console.warn('[notifyBoard] BOARD binding not configured, skipping notify for', techName);
    return;
  }
  try {
    // Path matters here -- this has to match crs-board's registered Hono
    // route (POST /internal/notify) exactly, not just hit some placeholder
    // host. Getting this wrong 404s silently (the service binding call
    // itself still "succeeds" from the Worker-invocation point of view).
    const res = await env.BOARD.fetch('https://board/internal/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Internal-Secret': env.BOARD_NOTIFY_SECRET },
      body: JSON.stringify({ techName, reason }),
    });
    console.log('[notifyBoard] notified', JSON.stringify(techName), reason, res.status, await res.text());
  } catch (err) {
    console.error('[notifyBoard] failed to notify', techName, err.message);
  }
}
