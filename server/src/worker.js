import { Hono } from 'hono';
import { api } from './routes.js';
import { tv, internal } from './tv.js';
import { runFsSync } from './fsSync.js';

const app = new Hono();
app.route('/api', api);
app.route('/api', tv);
app.route('/internal', internal);

export { TvChannel } from './tvChannel.js';

export default {
  // HTTP requests — handled by Hono as before.
  fetch: app.fetch.bind(app),

  // Cron trigger — fires every 5 minutes (configure in wrangler.toml).
  // Links unlinked FS tasks, syncs assignments, and refreshes the FS status
  // snapshot the board's drift badge reads. No longer writes a status to
  // either side — see statusMap.js header.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFsSync(env));
  },
};