import { Hono } from 'hono';
import { api } from './routes.js';
import { tv, internal } from './tv.js';
import { tasks } from './tasks.js';
import { runFsSync } from './fsSync.js';
import { rollupUsage, purgeOldUsageEvents } from './usageRollup.js';
import { getAuthSecret, resolveDeviceToken } from './auth.js';

const app = new Hono();

// Office-auth gate: every /api/* route requires a valid dispatch device token,
// EXCEPT the auth endpoints themselves and the public TV display. `/internal/*`
// (board→dispatch service-binding calls) is mounted separately below and stays
// on its own shared-secret check, so it's unaffected. Per-route admin checks
// (Usage, office-user management) happen in the handlers via getOfficeUser.
app.use('/api/*', async (c, next) => {
  const p = c.req.path;
  if (p.startsWith('/api/auth/') || p.startsWith('/api/tv/')) return next();
  const bearer = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const id = bearer ? await resolveDeviceToken(bearer, getAuthSecret(c.env)) : undefined;
  if (!id) return c.json({ error: 'Authentication required' }, 401);
  return next();
});

app.route('/api', api);
app.route('/api', tv);
app.route('/api', tasks);
app.route('/internal', internal);

export { TvChannel } from './tvChannel.js';

export default {
  // HTTP requests - handled by Hono as before.
  fetch: app.fetch.bind(app),

  // Cron triggers (wrangler.toml [triggers]): "*/5 * * * *" runs both jobs
  // below every tick; "0 3 * * *" additionally runs the daily usage purge,
  // distinguished via event.cron since one scheduled() handler covers every
  // configured pattern.
  async scheduled(event, env, ctx) {
    // Links unlinked FS tasks, syncs assignments, and refreshes the FS
    // status snapshot the board's drift badge reads. No longer writes a
    // status to either side - see statusMap.js header.
    ctx.waitUntil(runFsSync(env));
    // Idempotent recompute of the last 2 hours into usage_hourly_summary --
    // see usageRollup.js. Cheap enough to run on every 5-minute tick.
    ctx.waitUntil(rollupUsage(env));
    // Trims raw usage_events past its retention window -- once/day only,
    // see usageRollup.js's RETENTION_DAYS comment for why 120 days.
    if (event.cron === '0 3 * * *') ctx.waitUntil(purgeOldUsageEvents(env));
  },
};