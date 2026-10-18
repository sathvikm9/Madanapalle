CREATE TABLE IF NOT EXISTS collector_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'online', 'offline')),
  last_heartbeat_at TEXT,
  offline_since TEXT,
  last_offline_alert_at TEXT,
  last_recovery_at TEXT,
  agent_version TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_capture_checks (
  show_date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('complete', 'attention')),
  total_shows INTEGER NOT NULL,
  incomplete_shows INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS daily_capture_checks_status_date_idx
  ON daily_capture_checks (status, show_date DESC);

PRAGMA optimize;
