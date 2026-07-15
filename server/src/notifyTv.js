// Pushes a live "refresh" to any open /tv screen the moment we save a
// change that affects the warehouse calendar. Fire-and-forget: a delivery
// failure here must never break the caller's own successful Salesforce
// write, same convention as notifyBoard.js's notifyTech.
export async function notifyTv(env, reason) {
  if (!env.TV_CHANNEL) {
    console.warn('[notifyTv] TV_CHANNEL binding not configured, skipping notify:', reason);
    return;
  }
  try {
    const stub = env.TV_CHANNEL.get(env.TV_CHANNEL.idFromName('tv'));
    await stub.fetch('https://internal/push', { method: 'POST', body: JSON.stringify({ reason }) });
  } catch (err) {
    console.error('[notifyTv] failed to notify:', reason, err.message);
  }
}
