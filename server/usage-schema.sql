-- Usage analytics store (Cloudflare D1). Shared by crs-dispatch (this repo) and
-- crs-board via the USAGE_DB binding on each worker.
-- Apply:  wrangler d1 execute crs_usage --remote --file=server/usage-schema.sql
--   (add --local for the local dev DB)
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
