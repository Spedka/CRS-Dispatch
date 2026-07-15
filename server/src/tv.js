import { Hono } from 'hono';
import { getAllJobs, getAllTechnicians, getTimeOffRange } from './routes.js';
import { getOpenRequests } from './scheduleRequests.js';
import { notifyTv } from './notifyTv.js';

// Everything under /api/tv and /internal is intentionally its own router,
// mounted separately from the rest of /api in worker.js -- this is the seam
// that keeps the warehouse TV kiosk reachable with no login even after
// general dispatch-board auth gets added later. When that auth work lands,
// it should wrap the other /api/* route groups and simply never touch this
// one (or /internal, which stays behind its own shared-secret check below).
export const tv = new Hono();

function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function isoOf(d) {
  return d.toISOString().slice(0, 10);
}

// One combined payload -- jobs, technicians, open schedule requests, and
// time off for the padded month range around today -- so the TV kiosk does
// one fetch per refresh instead of four separate round trips.
tv.get('/tv/data', async (c) => {
  try {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const start = isoOf(startOfWeek(first));
    const end = isoOf(addDays(startOfWeek(last), 6));

    const [jobs, technicians, requests, timeOff] = await Promise.all([
      getAllJobs(c.env),
      getAllTechnicians(c.env),
      getOpenRequests(c.env),
      getTimeOffRange(c.env, start, end),
    ]);

    return c.json({ jobs, technicians, requests, timeOff, syncedAt: new Date().toISOString() });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Browser-facing WebSocket upgrade -- no token, genuinely open per the
// user's call, since this only ever streams a "something changed, refetch"
// signal, never any data itself.
tv.get('/tv/ws', async (c) => {
  if (!c.env.TV_CHANNEL) return c.text('Not available in this environment', 501);
  const stub = c.env.TV_CHANNEL.get(c.env.TV_CHANNEL.idFromName('tv'));
  return stub.fetch(c.req.raw);
});

// Machine-to-machine only -- called by crs-board's DISPATCH service binding
// when a tech creates/counters/edits/withdraws a schedule request, so the TV
// picks up tech-initiated changes live too, not just office-initiated ones.
// This one *is* secret-gated (unlike the public /tv/* routes above): a
// service-binding call still lands on this Worker's ordinary public fetch
// handler, so without a check anyone could spam refreshes by hitting it
// directly. Mirrors crs-board's own POST /internal/notify.
export const internal = new Hono();
internal.post('/tv-notify', async (c) => {
  if (c.req.header('X-Internal-Secret') !== c.env.DISPATCH_TV_NOTIFY_SECRET) return c.text('Unauthorized', 401);
  const { reason } = await c.req.json().catch(() => ({}));
  await notifyTv(c.env, reason ?? 'tech-request');
  return c.json({ ok: true });
});
