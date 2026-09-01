-- Usage analytics store (Cloudflare D1). Shared by crs-dispatch (this repo) and
-- crs-board via the USAGE_DB binding on each worker.
-- Apply:  wrangler d1 execute dispatch --remote --file=server/usage-schema.sql
--   (add --local for the local dev DB; "dispatch" is the database_name in
--   wrangler.toml's [[d1_databases]] block, not a placeholder)
CREATE TABLE IF NOT EXISTS usage_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,   -- epoch ms
  app    TEXT NOT NULL,      -- 'board' | 'dispatch'
  actor  TEXT,               -- tech name (board) / office User.Name (dispatch)
  event  TEXT NOT NULL,      -- 'login' | 'screen_view' | 'request_create' | ...
  screen TEXT,               -- screen/tab, when relevant
  props  TEXT                -- optional JSON detail
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events (ts);
CREATE INDEX IF NOT EXISTS idx_usage_actor ON usage_events (actor);

-- Hourly rollup of usage_events, added 2026-09-01 once crs-board's rollout
-- made the raw event rate (and so the Usage dashboard's own D1 read cost --
-- every GET /usage query re-scans the FULL raw-event window on every call)
-- start climbing toward the levels that caused the 6.8M-reads/day incident.
-- Kept current by a cron tick (server/src/usageRollup.js's rollupUsage(),
-- wired into worker.js's scheduled() on the existing */5 * * * * trigger) --
-- idempotent full recompute of the last 2 hours each tick, not an
-- incrementing counter, so a late-arriving raw write can never be
-- double-counted. GET /usage and GET /usage/user (routes.js) read this
-- table instead of usage_events directly; GET /usage/recent (the literal
-- per-event activity feed) still reads usage_events, same as before -- it
-- needs row-level detail a rollup can't preserve, and it's cheap already
-- (indexed ORDER BY ts DESC LIMIT n).
-- actor/screen are COALESCE'd to '' rather than left NULL when rolled up --
-- SQLite treats NULLs as mutually distinct for uniqueness purposes, which
-- would silently break INSERT OR REPLACE's ability to merge rows for
-- untracked-actor/no-screen events into one running bucket.
-- New deployments: after applying this file, run usage-summary-backfill.sql
-- ONCE to populate history (the rollup cron only ever looks back 2 hours,
-- so pre-existing older data needs the one-time backfill or it reads as
-- zero activity until it ages past the dashboard's day-window).
CREATE TABLE IF NOT EXISTS usage_hourly_summary (
  hour_bucket  INTEGER NOT NULL,  -- epoch ms, floored to the hour
  app          TEXT NOT NULL,
  actor        TEXT NOT NULL,     -- '' stands in for NULL, see comment above
  event        TEXT NOT NULL,
  screen       TEXT NOT NULL,     -- '' stands in for NULL/not-applicable
  cnt          INTEGER NOT NULL,
  duration_sum REAL,              -- sum of screen_view_end durationMs, this bucket only
  duration_cnt INTEGER,           -- how many of those contributed to duration_sum
  max_ts       INTEGER NOT NULL,  -- latest raw ts folded into this bucket row
  PRIMARY KEY (hour_bucket, app, actor, event, screen)
);
CREATE INDEX IF NOT EXISTS idx_usage_summary_hour ON usage_hourly_summary (hour_bucket);
CREATE INDEX IF NOT EXISTS idx_usage_summary_actor ON usage_hourly_summary (actor);
