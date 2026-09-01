-- One-time backfill: populates usage_hourly_summary from ALL pre-existing
-- usage_events, using the exact same grain/bucketing the recurring rollup
-- cron uses going forward (server/src/usageRollup.js's rollupUsage()) --
-- run this ONCE, right after applying usage-schema.sql's new table, so
-- history doesn't read as empty in the Usage dashboard until it ages past
-- the rollup cron's own 2-hour look-back window.
--
-- Safe to re-run any time (INSERT OR REPLACE on the summary table's own
-- primary key) -- e.g. if it's run again after a schema change, or as a
-- sanity re-sync if the two tables are ever suspected to have drifted.
--
-- Apply:  wrangler d1 execute dispatch --remote --file=server/usage-summary-backfill.sql
--   (add --local for the local dev DB)
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
GROUP BY hour_bucket, app, actor, screen, event;
