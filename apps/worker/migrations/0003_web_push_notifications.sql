CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time TEXT,
  device_name TEXT NOT NULL DEFAULT '',
  venues_json TEXT NOT NULL DEFAULT '["SKMD","SCM","RTDM","ASRM"]',
  types_json TEXT NOT NULL DEFAULT '["period_results","schedule_changes","daily_summary"]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS push_subscriptions_enabled_idx
  ON push_subscriptions (enabled, updated_at);

CREATE TABLE IF NOT EXISTS push_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  notification_key TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_attempt_at TEXT,
  sent_at TEXT,
  error TEXT,
  UNIQUE (subscription_id, notification_key)
);

CREATE INDEX IF NOT EXISTS push_deliveries_pending_idx
  ON push_deliveries (status, created_at);
