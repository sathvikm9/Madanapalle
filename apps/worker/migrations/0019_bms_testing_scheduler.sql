PRAGMA foreign_keys = ON;

-- The BMS testing pipeline is deliberately isolated from production shows and snapshots.
CREATE TABLE IF NOT EXISTS bms_testing_shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  natural_key TEXT NOT NULL UNIQUE,
  venue_code TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  show_date TEXT NOT NULL,
  show_date_code TEXT NOT NULL,
  show_time_code TEXT NOT NULL,
  show_time_label TEXT NOT NULL,
  start_at TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  capture_at TEXT NOT NULL,
  final_capture_at TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_code TEXT NOT NULL,
  movie_title TEXT NOT NULL,
  movie_variant TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT '',
  screen_name TEXT NOT NULL DEFAULT '',
  advertised_categories_json TEXT NOT NULL DEFAULT '[]',
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bms_testing_shows_date_idx
  ON bms_testing_shows (show_date, venue_code, start_at);

CREATE TABLE IF NOT EXISTS bms_testing_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  testing_show_id INTEGER NOT NULL REFERENCES bms_testing_shows(id),
  phase TEXT NOT NULL CHECK (phase IN ('initial', 'final')),
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'bookmyshow-server-testing',
  capacity INTEGER NOT NULL,
  available INTEGER NOT NULL,
  sold INTEGER NOT NULL,
  unknown INTEGER NOT NULL DEFAULT 0,
  collection_paise INTEGER NOT NULL,
  occupancy_percent REAL NOT NULL,
  categories_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (testing_show_id, phase)
);

CREATE INDEX IF NOT EXISTS bms_testing_snapshots_show_idx
  ON bms_testing_snapshots (testing_show_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS bms_testing_capture_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  testing_show_id INTEGER NOT NULL REFERENCES bms_testing_shows(id),
  phase TEXT NOT NULL CHECK (phase IN ('initial', 'final')),
  due_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  last_error TEXT,
  snapshot_id INTEGER REFERENCES bms_testing_snapshots(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (testing_show_id, phase)
);

CREATE INDEX IF NOT EXISTS bms_testing_capture_jobs_due_idx
  ON bms_testing_capture_jobs (status, next_attempt_at, deadline_at);

CREATE TABLE IF NOT EXISTS bms_testing_discovery_state (
  venue_code TEXT NOT NULL,
  show_date TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  lease_expires_at TEXT,
  last_status TEXT,
  last_error TEXT,
  last_started_at TEXT,
  last_finished_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (venue_code, show_date)
);

CREATE INDEX IF NOT EXISTS bms_testing_discovery_due_idx
  ON bms_testing_discovery_state (show_date, next_attempt_at);

CREATE TABLE IF NOT EXISTS bms_testing_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL CHECK (run_type IN ('discovery', 'capture')),
  venue_code TEXT,
  show_date TEXT,
  testing_show_id INTEGER REFERENCES bms_testing_shows(id),
  phase TEXT,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  http_status INTEGER,
  error_code TEXT,
  error TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS bms_testing_runs_started_idx
  ON bms_testing_runs (started_at DESC);
