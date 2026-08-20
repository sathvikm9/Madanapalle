PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  natural_key TEXT NOT NULL UNIQUE,
  slot_key TEXT NOT NULL,
  venue_code TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  show_date TEXT NOT NULL,
  show_date_code TEXT NOT NULL,
  show_time_code TEXT NOT NULL,
  show_time_label TEXT NOT NULL,
  start_at TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  capture_at TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_code TEXT NOT NULL,
  movie_title TEXT NOT NULL,
  movie_variant TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT '',
  attributes TEXT NOT NULL DEFAULT '',
  screen_name TEXT NOT NULL DEFAULT '',
  seat_layout_url TEXT NOT NULL,
  advertised_categories_json TEXT NOT NULL DEFAULT '[]',
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'scheduled',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  replaced_at TEXT,
  removed_at TEXT,
  capture_attempts INTEGER NOT NULL DEFAULT 0,
  last_capture_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS shows_date_idx ON shows (venue_code, show_date, start_at);
CREATE INDEX IF NOT EXISTS shows_slot_idx ON shows (slot_key, is_current);
CREATE INDEX IF NOT EXISTS shows_finalize_idx ON shows (is_current, status, cutoff_at);

CREATE TABLE IF NOT EXISTS schedule_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_code TEXT NOT NULL,
  show_date TEXT NOT NULL,
  slot_key TEXT,
  event_type TEXT NOT NULL,
  previous_show_id INTEGER REFERENCES shows(id),
  next_show_id INTEGER REFERENCES shows(id),
  details_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS schedule_events_date_idx ON schedule_events (venue_code, show_date, observed_at);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL REFERENCES shows(id),
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  capture_minute TEXT NOT NULL,
  source TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  available INTEGER NOT NULL,
  sold INTEGER NOT NULL,
  unknown INTEGER NOT NULL DEFAULT 0,
  collection_paise INTEGER NOT NULL,
  occupancy_percent REAL NOT NULL,
  categories_json TEXT NOT NULL,
  is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1)),
  raw_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS snapshots_show_idx ON snapshots (show_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS collector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,
  venue_code TEXT,
  target_date TEXT,
  show_id INTEGER REFERENCES shows(id),
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  error TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS collector_runs_started_idx ON collector_runs (started_at DESC);
