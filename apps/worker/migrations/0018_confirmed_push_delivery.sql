ALTER TABLE push_deliveries ADD COLUMN receipt_token TEXT;
ALTER TABLE push_deliveries ADD COLUMN accepted_at TEXT;
ALTER TABLE push_deliveries ADD COLUMN acknowledged_at TEXT;

UPDATE push_deliveries
SET accepted_at=COALESCE(accepted_at, sent_at),
    acknowledged_at=COALESCE(acknowledged_at, sent_at)
WHERE status='sent';

CREATE UNIQUE INDEX IF NOT EXISTS push_deliveries_receipt_token_idx
  ON push_deliveries (receipt_token)
  WHERE receipt_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS push_deliveries_confirmation_idx
  ON push_deliveries (status, next_attempt_at, attempts, acknowledged_at);
