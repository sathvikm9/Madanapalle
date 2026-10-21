import { venueForCode } from "./venues.js";
import { collectorAgentsStatus } from "./collector-agents.js";

export const COLLECTOR_HEARTBEAT_INTERVAL_MINUTES = 5;
export const COLLECTOR_STALE_AFTER_MINUTES = 20;
export const COLLECTOR_STALE_AFTER_MS = COLLECTOR_STALE_AFTER_MINUTES * 60_000;
export const END_OF_DAY_CHECK_GRACE_MS = 5 * 60_000;

const INDIA_TIMEZONE = "Asia/Kolkata";
const ACTIVE_START_MINUTE = 3 * 60;
const END_OF_DAY_CHECK_START_MINUTE = 19 * 60;

function indiaParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  return Object.fromEntries(parts
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
}

export function indiaDate(now = new Date()) {
  const parts = indiaParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function indiaMinuteOfDay(now = new Date()) {
  const parts = indiaParts(now);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function collectorWindowActive(now = new Date()) {
  return indiaMinuteOfDay(now) >= ACTIVE_START_MINUTE;
}

function finiteAgeMs(value, now) {
  const seenAt = new Date(value || "").getTime();
  return Number.isFinite(seenAt) ? Math.max(0, now.getTime() - seenAt) : null;
}

export function collectorStatusFromRow(row, now = new Date()) {
  const lastSeenAt = row?.last_heartbeat_at || null;
  const ageMs = finiteAgeMs(lastSeenAt, now);
  const monitoring = ageMs != null;
  const activeWindow = collectorWindowActive(now);
  let status = "unknown";
  if (monitoring) {
    if (activeWindow && ageMs >= COLLECTOR_STALE_AFTER_MS) status = "offline";
    else if (!activeWindow && ageMs >= COLLECTOR_STALE_AFTER_MS) status = "idle";
    else status = "online";
  }
  return {
    status,
    monitoring,
    activeWindow,
    lastSeenAt,
    offlineSince: row?.offline_since || null,
    lastRecoveryAt: row?.last_recovery_at || null,
    agentVersion: row?.agent_version || null,
    staleAfterMinutes: COLLECTOR_STALE_AFTER_MINUTES,
    heartbeatIntervalMinutes: COLLECTOR_HEARTBEAT_INTERVAL_MINUTES,
    minutesSinceLastSeen: ageMs == null ? null : Math.floor(ageMs / 60_000)
  };
}

export async function collectorHealthStatus(db, now = new Date()) {
  const row = await db.prepare("SELECT * FROM collector_health WHERE id=1").first();
  const agents = await collectorAgentsStatus(db, now);
  const liveAgents = agents.filter((agent) => agent.automaticCapture && agent.status === "live");
  const freshestLiveAgent = liveAgents.reduce((freshest, agent) => {
    if (!freshest) return agent;
    return new Date(agent.lastSeenAt).getTime() > new Date(freshest.lastSeenAt).getTime()
      ? agent
      : freshest;
  }, null);
  const base = collectorStatusFromRow(row, now);
  return {
    ...base,
    ...(agents.length ? {
      status: liveAgents.length ? "online" : base.activeWindow ? "offline" : "idle",
      monitoring: base.monitoring || agents.some((agent) => agent.lastSeenAt),
      lastSeenAt: freshestLiveAgent?.lastSeenAt || base.lastSeenAt,
      minutesSinceLastSeen: freshestLiveAgent?.minutesSinceLastSeen ?? base.minutesSinceLastSeen
    } : {}),
    agents,
    liveAgents: liveAgents.length
  };
}

function healthEventStatement(db, {
  key,
  type,
  payload,
  now
}) {
  const timestamp = now.toISOString();
  return db.prepare(
    `INSERT OR IGNORE INTO notification_events (
       event_key, event_type, payload_json, due_at, status, created_at
     ) VALUES (?, ?, ?, ?, 'pending', ?)`
  ).bind(key, type, JSON.stringify(payload), timestamp, timestamp);
}

export async function recordCollectorHeartbeat(db, heartbeat, now = new Date()) {
  const timestamp = now.toISOString();
  const previous = await db.prepare("SELECT * FROM collector_health WHERE id=1").first();
  const recovered = previous?.status === "offline";
  const previousOfflineSince = previous?.offline_since || null;
  const details = {
    automaticCapture: Boolean(heartbeat.automaticCapture),
    pendingUploads: Number(heartbeat.pendingUploads || 0),
    clientAt: heartbeat.clientAt || null,
    indiaDateCode: heartbeat.indiaDateCode || null
  };
  const statements = [
    db.prepare(
      `INSERT INTO collector_health (
         id, status, last_heartbeat_at, offline_since, last_recovery_at,
         agent_version, details_json, created_at, updated_at
       ) VALUES (1, 'online', ?, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status='online',
         last_heartbeat_at=excluded.last_heartbeat_at,
         offline_since=NULL,
         last_recovery_at=CASE WHEN collector_health.status='offline'
           THEN excluded.last_heartbeat_at ELSE collector_health.last_recovery_at END,
         agent_version=excluded.agent_version,
         details_json=excluded.details_json,
         updated_at=excluded.updated_at`
    ).bind(
      timestamp,
      recovered ? timestamp : null,
      heartbeat.agentVersion,
      JSON.stringify(details),
      timestamp,
      timestamp
    )
  ];
  if (recovered) {
    statements.push(healthEventStatement(db, {
      key: `collector-recovered:${previousOfflineSince || timestamp}`,
      type: "collector_recovered",
      payload: {
        recoveredAt: timestamp,
        offlineSince: previousOfflineSince,
        agentVersion: heartbeat.agentVersion
      },
      now
    }));
  }
  await db.batch(statements);
  return {
    ...collectorStatusFromRow({
      ...previous,
      status: "online",
      last_heartbeat_at: timestamp,
      offline_since: null,
      last_recovery_at: recovered ? timestamp : previous?.last_recovery_at,
      agent_version: heartbeat.agentVersion
    }, now),
    recovered
  };
}

export async function evaluateCollectorHealth(db, now = new Date()) {
  if (!collectorWindowActive(now)) return { activeWindow: false, changed: false };
  const row = await db.prepare("SELECT * FROM collector_health WHERE id=1").first();
  const status = collectorStatusFromRow(row, now);
  if (!status.monitoring || status.status !== "offline" || row?.status === "offline") {
    return { ...status, changed: false };
  }
  const timestamp = now.toISOString();
  const offlineSince = new Date(
    new Date(status.lastSeenAt).getTime() + COLLECTOR_STALE_AFTER_MS
  ).toISOString();
  await db.batch([
    db.prepare(
      `UPDATE collector_health SET status='offline', offline_since=?,
         last_offline_alert_at=?, updated_at=? WHERE id=1 AND status<>'offline'`
    ).bind(offlineSince, timestamp, timestamp),
    healthEventStatement(db, {
      key: `collector-offline:${offlineSince}`,
      type: "collector_offline",
      payload: {
        lastHeartbeatAt: status.lastSeenAt,
        offlineSince,
        staleAfterMinutes: COLLECTOR_STALE_AFTER_MINUTES,
        agentVersion: status.agentVersion
      },
      now
    })
  ]);
  return { ...status, offlineSince, changed: true };
}

function incompleteShow(row) {
  return {
    showId: String(row.id),
    venueCode: row.venue_code,
    venueName: venueForCode(row.venue_code)?.shortName || row.venue_code,
    showTime: row.show_time_label,
    movieTitle: row.movie_title,
    status: row.status
  };
}

export async function runEndOfDayCompletenessCheck(db, now = new Date()) {
  if (indiaMinuteOfDay(now) < END_OF_DAY_CHECK_START_MINUTE) {
    return { due: false, checked: false };
  }
  const showDate = indiaDate(now);
  const existing = await db.prepare(
    "SELECT status, total_shows, incomplete_shows, checked_at FROM daily_capture_checks WHERE show_date=?"
  ).bind(showDate).first();
  if (existing) {
    return {
      due: true,
      checked: true,
      status: existing.status,
      totalShows: Number(existing.total_shows),
      incompleteShows: Number(existing.incomplete_shows),
      checkedAt: existing.checked_at
    };
  }
  const summary = await db.prepare(
    `SELECT COUNT(*) AS total_shows, MAX(cutoff_at) AS latest_cutoff
     FROM shows WHERE show_date=? AND is_current=1`
  ).bind(showDate).first();
  const totalShows = Number(summary?.total_shows || 0);
  const latestCutoff = new Date(summary?.latest_cutoff || "").getTime();
  if (!totalShows || !Number.isFinite(latestCutoff) || now.getTime() < latestCutoff + END_OF_DAY_CHECK_GRACE_MS) {
    return { due: false, checked: false, totalShows };
  }
  const result = await db.prepare(
    `SELECT shows.id, shows.venue_code, shows.show_time_label, shows.movie_title, shows.status
     FROM shows
     WHERE shows.show_date=? AND shows.is_current=1 AND (
       shows.status<>'completed' OR NOT EXISTS (
         SELECT 1 FROM snapshots WHERE snapshots.show_id=shows.id AND snapshots.is_final=1
       )
     )
     ORDER BY shows.start_at ASC, shows.venue_code ASC`
  ).bind(showDate).all();
  const incomplete = (result.results || []).map(incompleteShow);
  const status = incomplete.length ? "attention" : "complete";
  const timestamp = now.toISOString();
  const statements = [
    db.prepare(
      `INSERT OR IGNORE INTO daily_capture_checks (
         show_date, status, total_shows, incomplete_shows, checked_at, details_json
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(showDate, status, totalShows, incomplete.length, timestamp, JSON.stringify({ incomplete }))
  ];
  if (incomplete.length) {
    statements.push(healthEventStatement(db, {
      key: `daily-incomplete:${showDate}`,
      type: "daily_incomplete",
      payload: { showDate, totalShows, incomplete },
      now
    }));
  }
  await db.batch(statements);
  return {
    due: true,
    checked: true,
    status,
    totalShows,
    incompleteShows: incomplete.length,
    incomplete,
    checkedAt: timestamp
  };
}
