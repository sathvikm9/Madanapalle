ALTER TABLE snapshots ADD COLUMN client_capture_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS snapshots_client_capture_id_idx
  ON snapshots (client_capture_id)
  WHERE client_capture_id IS NOT NULL;
