ALTER TABLE push_subscriptions ADD COLUMN installation_id TEXT;

ALTER TABLE push_deliveries ADD COLUMN due_at TEXT;
ALTER TABLE push_deliveries ADD COLUMN next_attempt_at TEXT;

UPDATE push_deliveries
SET due_at=created_at, next_attempt_at=created_at
WHERE due_at IS NULL OR next_attempt_at IS NULL;

-- Legacy subscriptions cannot be mapped safely to one physical installation.
-- Each intended PWA will register again with its durable installation ID.
UPDATE push_subscriptions SET enabled=0 WHERE installation_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_installation_idx
  ON push_subscriptions (installation_id)
  WHERE installation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS push_deliveries_due_idx
  ON push_deliveries (status, due_at, next_attempt_at, attempts);

CREATE INDEX IF NOT EXISTS shows_date_current_start_idx
  ON shows (show_date, is_current, start_at, venue_code);

CREATE INDEX IF NOT EXISTS shows_pending_cutoff_idx
  ON shows (is_current, status, cutoff_at);

CREATE INDEX IF NOT EXISTS snapshots_show_final_capture_idx
  ON snapshots (show_id, is_final, captured_at DESC);

CREATE TABLE IF NOT EXISTS notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  show_date TEXT,
  venue_code TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS notification_events_due_idx
  ON notification_events (status, due_at, attempts);

CREATE TABLE IF NOT EXISTS pwa_installations (
  installation_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  install_source TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  notification_enabled INTEGER NOT NULL DEFAULT 0 CHECK (notification_enabled IN (0, 1)),
  notification_enabled_at TEXT,
  notification_disabled_at TEXT
);

CREATE INDEX IF NOT EXISTS pwa_installations_notifications_idx
  ON pwa_installations (notification_enabled, last_seen_at);
