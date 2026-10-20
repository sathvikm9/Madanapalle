import { RequestError, requiredString } from "./logic.js";

const ACTIVE_AGENT_MS = 10 * 60_000;
const PRIMARY_GRACE_MS = 15_000;
const CLAIM_LEASE_MS = 18_000;

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bearerToken(request) {
  const header = String(request.headers.get("authorization") || "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function publicAgent(row, now = new Date()) {
  const lastSeen = new Date(row.last_heartbeat_at || "").getTime();
  const age = Number.isFinite(lastSeen) ? Math.max(0, now.getTime() - lastSeen) : null;
  const enabled = Number(row.automatic_capture) === 1;
  return {
    agentId: row.agent_id,
    name: row.name,
    role: Number(row.role_priority) <= 10 ? "primary" : "backup",
    rolePriority: Number(row.role_priority),
    automaticCapture: enabled,
    status: !enabled ? "off" : age != null && age < ACTIVE_AGENT_MS ? "live" : "offline",
    lastSeenAt: row.last_heartbeat_at || null,
    minutesSinceLastSeen: age == null ? null : Math.floor(age / 60_000),
    agentVersion: row.agent_version || null,
    pendingUploads: Number(row.pending_uploads || 0)
  };
}

export async function authenticateCollector(request, env, db) {
  const token = bearerToken(request);
  if (!token) throw new RequestError("Unauthorized", 401, "unauthorized");
  if (env.AGENT_TOKEN && token === env.AGENT_TOKEN) {
    return { agentId: "legacy-primary", name: "Home laptop", rolePriority: 10, legacy: true };
  }
  const tokenHash = await sha256(token);
  const row = await db.prepare(
    "SELECT * FROM collector_agents WHERE token_hash=? AND revoked_at IS NULL"
  ).bind(tokenHash).first();
  if (!row) throw new RequestError("Unauthorized", 401, "unauthorized");
  return {
    agentId: row.agent_id,
    name: row.name,
    rolePriority: Number(row.role_priority),
    legacy: false
  };
}

function validAgentId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new RequestError("agentId is invalid");
  return id;
}

async function saveCredential(db, { agentId, name, rolePriority }, now = new Date()) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const timestamp = now.toISOString();
  await db.prepare(
    `INSERT INTO collector_agents (
       agent_id, name, role_priority, token_hash, automatic_capture,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       name=excluded.name, role_priority=excluded.role_priority,
       token_hash=excluded.token_hash, revoked_at=NULL, updated_at=excluded.updated_at`
  ).bind(agentId, name, rolePriority, tokenHash, timestamp, timestamp).run();
  return { agentId, agentToken: token, name, rolePriority };
}

export async function enrollCollector(db, env, body, now = new Date()) {
  const suppliedCode = requiredString(body?.connectionCode, "connectionCode", 100);
  if (!env.COLLECTOR_SETUP_CODE || await sha256(suppliedCode) !== await sha256(env.COLLECTOR_SETUP_CODE)) {
    throw new RequestError("Connection code is incorrect", 401, "invalid_connection_code");
  }
  const agentId = validAgentId(body?.agentId);
  const name = requiredString(body?.name, "name", 60);
  const existing = await db.prepare(
    "SELECT role_priority FROM collector_agents WHERE agent_id=? AND revoked_at IS NULL"
  ).bind(agentId).first();
  const next = await db.prepare(
    "SELECT COALESCE(MAX(role_priority), 10) + 10 AS priority FROM collector_agents"
  ).first();
  return saveCredential(db, {
    agentId,
    name,
    rolePriority: existing
      ? Number(existing.role_priority)
      : Math.max(20, Number(next?.priority || 20))
  }, now);
}

export async function registerLegacyCollector(db, agent, body, now = new Date()) {
  if (!agent.legacy) return { ...agent, alreadyRegistered: true };
  const agentId = validAgentId(body?.agentId);
  const existing = await db.prepare(
    "SELECT role_priority FROM collector_agents WHERE agent_id=? AND revoked_at IS NULL"
  ).bind(agentId).first();
  const current = await db.prepare(
    "SELECT COUNT(*) AS total, COALESCE(MAX(role_priority), 0) AS maximum FROM collector_agents WHERE revoked_at IS NULL"
  ).first();
  return saveCredential(db, {
    agentId,
    name: body?.name ? requiredString(body.name, "name", 60) : "Home laptop",
    rolePriority: existing
      ? Number(existing.role_priority)
      : Number(current?.total || 0) === 0 ? 10 : Math.max(20, Number(current?.maximum || 10) + 10)
  }, now);
}

export async function makeCollectorPrimary(db, agentId, now = new Date()) {
  const timestamp = now.toISOString();
  await db.batch([
    db.prepare(
      "UPDATE collector_agents SET role_priority=role_priority+10, updated_at=? WHERE revoked_at IS NULL AND agent_id<>? AND role_priority<=10"
    ).bind(timestamp, agentId),
    db.prepare(
      "UPDATE collector_agents SET role_priority=10, updated_at=? WHERE agent_id=? AND revoked_at IS NULL"
    ).bind(timestamp, agentId)
  ]);
  return { ok: true, agentId, role: "primary" };
}

export async function recordAgentHeartbeat(db, agent, heartbeat, now = new Date()) {
  const timestamp = now.toISOString();
  await db.prepare(
    `INSERT INTO collector_agents (
       agent_id, name, role_priority, automatic_capture, last_heartbeat_at,
       agent_version, pending_uploads, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       name=excluded.name, automatic_capture=excluded.automatic_capture,
       last_heartbeat_at=excluded.last_heartbeat_at, agent_version=excluded.agent_version,
       pending_uploads=excluded.pending_uploads, updated_at=excluded.updated_at`
  ).bind(
    agent.agentId,
    heartbeat.agentName || agent.name,
    agent.rolePriority,
    heartbeat.automaticCapture ? 1 : 0,
    timestamp,
    heartbeat.agentVersion,
    Number(heartbeat.pendingUploads || 0),
    timestamp,
    timestamp
  ).run();
}

export async function collectorAgentsStatus(db, now = new Date()) {
  const result = await db.prepare(
    "SELECT * FROM collector_agents WHERE revoked_at IS NULL ORDER BY role_priority ASC, name ASC"
  ).all();
  return (result.results || []).map((row) => publicAgent(row, now));
}

function phaseDueAt(show, phase) {
  return phase === "final"
    ? new Date(new Date(show.cutoff_at).getTime() - 60_000).getTime()
    : new Date(show.capture_at).getTime();
}

export async function claimCapture(db, agent, show, phase, now = new Date()) {
  if (!new Set(["backup", "final"]).has(phase)) throw new RequestError("phase must be backup or final");
  const nowMs = now.getTime();
  const timestamp = now.toISOString();
  const protectedSnapshot = await db.prepare(
    `SELECT id FROM snapshots WHERE show_id=? AND (
       (?='final' AND julianday(captured_at) >= julianday(?, '-1 minute')) OR
       (?='backup' AND julianday(captured_at) < julianday(?, '-1 minute'))
     ) LIMIT 1`
  ).bind(show.id, phase, show.cutoff_at, phase, show.cutoff_at).first();
  if (protectedSnapshot) return { granted: false, protected: true, reason: "already_captured" };

  const existing = await db.prepare(
    "SELECT * FROM capture_claims WHERE show_id=? AND capture_phase=?"
  ).bind(show.id, phase).first();
  if (existing?.status === "completed") {
    return { granted: false, protected: true, reason: "already_completed" };
  }
  const existingLease = new Date(existing?.lease_expires_at || "").getTime();
  if (existing && existing.agent_id !== agent.agentId && existingLease > nowMs) {
    return { granted: false, protected: false, reason: "claimed", retryAt: existing.lease_expires_at };
  }

  const liveAfter = new Date(nowMs - ACTIVE_AGENT_MS).toISOString();
  const preferred = await db.prepare(
    `SELECT agent_id FROM collector_agents
     WHERE automatic_capture=1 AND revoked_at IS NULL AND last_heartbeat_at>=?
     ORDER BY role_priority ASC, last_heartbeat_at DESC LIMIT 1`
  ).bind(liveAfter).first();
  const takeoverAt = phaseDueAt(show, phase) + PRIMARY_GRACE_MS;
  if (preferred && preferred.agent_id !== agent.agentId && nowMs < takeoverAt) {
    return {
      granted: false,
      protected: false,
      reason: "standby",
      retryAt: new Date(takeoverAt).toISOString()
    };
  }

  const leaseExpiresAt = new Date(nowMs + CLAIM_LEASE_MS).toISOString();
  await db.prepare(
    `INSERT INTO capture_claims (
       show_id, capture_phase, agent_id, status, claimed_at, lease_expires_at, completed_at
     ) VALUES (?, ?, ?, 'claimed', ?, ?, NULL)
     ON CONFLICT(show_id, capture_phase) DO UPDATE SET
       agent_id=excluded.agent_id, status='claimed', claimed_at=excluded.claimed_at,
       lease_expires_at=excluded.lease_expires_at, completed_at=NULL`
  ).bind(show.id, phase, agent.agentId, timestamp, leaseExpiresAt).run();
  return { granted: true, protected: false, phase, leaseExpiresAt };
}

export async function completeCaptureClaim(db, agentId, show, capturedAt, now = new Date()) {
  const phase = new Date(capturedAt).getTime() >= new Date(show.cutoff_at).getTime() - 60_000
    ? "final"
    : "backup";
  await db.prepare(
    `UPDATE capture_claims SET status='completed', completed_at=?, lease_expires_at=?
     WHERE show_id=? AND capture_phase=? AND agent_id=?`
  ).bind(now.toISOString(), now.toISOString(), show.id, phase, agentId).run();
  return phase;
}
