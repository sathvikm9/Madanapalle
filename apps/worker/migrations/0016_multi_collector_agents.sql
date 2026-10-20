CREATE TABLE IF NOT EXISTS collector_agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role_priority INTEGER NOT NULL DEFAULT 100,
  token_hash TEXT UNIQUE,
  automatic_capture INTEGER NOT NULL DEFAULT 0 CHECK (automatic_capture IN (0, 1)),
  last_heartbeat_at TEXT,
  agent_version TEXT,
  pending_uploads INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS collector_agents_capture_priority_idx
  ON collector_agents (automatic_capture, revoked_at, role_priority, last_heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS capture_claims (
  show_id INTEGER NOT NULL,
  capture_phase TEXT NOT NULL CHECK (capture_phase IN ('backup', 'final')),
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'completed')),
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (show_id, capture_phase),
  FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES collector_agents(agent_id)
);

CREATE INDEX IF NOT EXISTS capture_claims_agent_lease_idx
  ON capture_claims (agent_id, status, lease_expires_at);

PRAGMA optimize;
