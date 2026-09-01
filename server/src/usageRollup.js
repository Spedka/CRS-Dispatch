// Keeps usage_hourly_summary current (rollupUsage) and trims raw
// usage_events history (purgeOldUsageEvents) -- see usage-schema.sql's
// comment on the summary table for the why. Both are called from
// worker.js's scheduled() handler; both are cheap no-ops if USAGE_DB isn't
// bound (e.g. under dev:node-style local runs with no D1 available).

const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;

// Every rollup tick fully RECOMPUTES the last ROLLUP_WINDOW_MS worth of
// hour-buckets from raw usage_events and INSERT OR REPLACEs them -- not an
// incrementing counter. That's deliberate: an incrementing design needs a
// cursor and breaks (double-counts) the moment the same raw row is ever
// reprocessed, e.g. a fire-and-forget POST /track landing a few seconds
// late relative to its own timestamp. A full recompute of a short trailing
// window is idempotent by construction -- rerun it as often as the cron
// allows, always correct, no cursor to get wrong. 2 hours is generous slack
// for that kind of late arrival; older raw events aren't touched further
// (their bucket rows are already settled).
const ROLLUP_WINDOW_MS = HOUR_MS * 2;

// Same SELECT shape as usage-summary-backfill.sql's one-time backfill --
// keep the two in sync if this ever changes (columns, COALESCE handling,
// duration extraction all need to match or the two tables would disagree).
const ROLLUP_UPSERT_SQL = `
  INSERT OR REPLACE INTO usage_hourly_summary
    (hour_bucket, app, actor, event, screen, cnt, duration_sum, duration_cnt, max_ts)
  SELECT
    (ts / 3600000) * 3600000 AS hour_bucket,
    app,
    COALESCE(actor, '')      AS actor,
    event,
    COALESCE(screen, '')     AS screen,
    COUNT(*)                 AS cnt,
    SUM(CASE WHEN event = 'screen_view_end' THEN CAST(json_extract(props, '$.durationMs') AS REAL) END) AS duration_sum,
    SUM(CASE WHEN event = 'screen_view_end' AND json_extract(props, '$.durationMs') IS NOT NULL THEN 1 ELSE 0 END) AS duration_cnt,
    MAX(ts)                  AS max_ts
  FROM usage_events
  WHERE ts >= ?
  GROUP BY hour_bucket, app, actor, screen, event
`;

export async function rollupUsage(env) {
  const db = env.USAGE_DB;
  if (!db) return;
  // Floored to the hour so the window always covers whole buckets.
  const since = Math.floor((Date.now() - ROLLUP_WINDOW_MS) / HOUR_MS) * HOUR_MS;
  await db.prepare(ROLLUP_UPSERT_SQL).bind(since).run();
}

// Raw usage_events beyond this age has no reader left: the dashboard's own
// day-range picker tops out at 90 days (usageDays() in routes.js), and
// every aggregate read goes through usage_hourly_summary, not the raw
// table, as of 2026-09-01. 120 days is a deliberate buffer above that
// 90-day ceiling, not a coincidence -- room to widen the dashboard's range
// later without this purge having already thrown away what it'd need.
// Only usage_events is trimmed -- usage_hourly_summary is left alone
// (small, cheap, and doubles as a long-term trend archive once the raw
// detail behind it is gone).
const RETENTION_DAYS = 120;

export async function purgeOldUsageEvents(env) {
  const db = env.USAGE_DB;
  if (!db) return;
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
  await db.prepare('DELETE FROM usage_events WHERE ts < ?').bind(cutoff).run();
}
