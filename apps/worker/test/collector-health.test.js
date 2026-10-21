import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  collectorHealthStatus,
  collectorStatusFromRow,
  collectorWindowActive,
  evaluateCollectorHealth,
  indiaDate,
  recordCollectorHeartbeat,
  runEndOfDayCompletenessCheck
} from "../src/collector-health.js";

function fakeDb({ health = null, dailyCheck = null, summary = null, incomplete = [], agents = [] } = {}) {
  const batches = [];
  const prepared = [];
  return {
    batches,
    prepared,
    prepare(sql) {
      const make = (values = []) => ({
        sql,
        values,
        async first() {
          if (sql.includes("FROM collector_health")) return health;
          if (sql.includes("FROM daily_capture_checks")) return dailyCheck;
          if (sql.includes("COUNT(*) AS total_shows")) return summary;
          return null;
        },
        async all() {
          if (sql.includes("FROM collector_agents")) return { results: agents };
          if (sql.includes("FROM shows") && sql.includes("snapshots.is_final=1")) {
            return { results: incomplete };
          }
          return { results: [] };
        },
        async run() { return { success: true }; }
      });
      const direct = make();
      return {
        ...direct,
        bind(...values) {
          const statement = make(values);
          prepared.push(statement);
          return statement;
        }
      };
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    }
  };
}

test("multi-laptop health uses the freshest enabled collector", async () => {
  const now = new Date("2026-10-20T23:10:00.000Z");
  const db = fakeDb({
    health: {
      status: "online",
      last_heartbeat_at: "2026-10-20T23:09:00.000Z",
      agent_version: "1.20.7"
    },
    agents: [
      {
        agent_id: "main-agent",
        name: "Main",
        role_priority: 10,
        automatic_capture: 1,
        last_heartbeat_at: "2026-10-20T23:02:00.000Z",
        agent_version: "1.20.7",
        pending_uploads: 0
      },
      {
        agent_id: "backup-agent",
        name: "Mac",
        role_priority: 20,
        automatic_capture: 1,
        last_heartbeat_at: "2026-10-20T23:09:00.000Z",
        agent_version: "1.20.7",
        pending_uploads: 0
      }
    ]
  });

  const status = await collectorHealthStatus(db, now);

  assert.equal(status.status, "online");
  assert.equal(status.lastSeenAt, "2026-10-20T23:09:00.000Z");
  assert.equal(status.minutesSinceLastSeen, 1);
  assert.equal(status.liveAgents, 2);
});

test("collector watchdog uses the India cinema day and a twenty-minute threshold", () => {
  const active = new Date("2026-10-18T08:30:00.000Z"); // 2:00 PM IST
  const overnight = new Date("2026-10-18T20:30:00.000Z"); // 2:00 AM IST next day
  assert.equal(collectorWindowActive(active), true);
  assert.equal(collectorWindowActive(overnight), false);
  assert.equal(indiaDate(overnight), "2026-10-19");
  assert.equal(collectorStatusFromRow({
    status: "online",
    last_heartbeat_at: "2026-10-18T08:09:59.000Z"
  }, active).status, "offline");
  assert.equal(collectorStatusFromRow({
    status: "online",
    last_heartbeat_at: "2026-10-18T20:00:00.000Z"
  }, overnight).status, "idle");
});

test("stale collector queues one idempotent offline event", async () => {
  const db = fakeDb({
    health: {
      status: "online",
      last_heartbeat_at: "2026-10-18T08:00:00.000Z",
      agent_version: "1.18.0"
    }
  });
  const result = await evaluateCollectorHealth(db, new Date("2026-10-18T08:21:00.000Z"));
  assert.equal(result.changed, true);
  assert.equal(db.batches.length, 1);
  assert.match(db.batches[0][0].sql, /status='offline'/);
  assert.match(db.batches[0][1].sql, /INSERT OR IGNORE INTO notification_events/);
  assert.equal(db.batches[0][1].values[1], "collector_offline");
});

test("first heartbeat after an outage queues one recovery event", async () => {
  const db = fakeDb({
    health: {
      status: "offline",
      last_heartbeat_at: "2026-10-18T08:00:00.000Z",
      offline_since: "2026-10-18T08:20:00.000Z",
      last_recovery_at: null
    }
  });
  const result = await recordCollectorHeartbeat(db, {
    agentVersion: "1.18.0",
    clientAt: "2026-10-18T08:31:00.000Z",
    automaticCapture: true,
    pendingUploads: 0,
    indiaDateCode: "20261018"
  }, new Date("2026-10-18T08:31:00.000Z"));
  assert.equal(result.recovered, true);
  assert.equal(db.batches[0][1].values[1], "collector_recovered");
});

test("end-of-day check records and alerts only when finalized shows are missing", async () => {
  const db = fakeDb({
    summary: { total_shows: 16, latest_cutoff: "2026-10-18T16:20:00.000Z" },
    incomplete: [{
      id: 42,
      venue_code: "RTDM",
      show_time_label: "09:30 PM",
      movie_title: "Jailer 2",
      status: "missed"
    }]
  });
  const result = await runEndOfDayCompletenessCheck(db, new Date("2026-10-18T16:26:00.000Z"));
  assert.equal(result.status, "attention");
  assert.equal(result.incompleteShows, 1);
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0][1].values[1], "daily_incomplete");
  assert.match(db.batches[0][1].values[2], /Ravi/);
});

test("watchdog migration keeps health work compact and indexed", () => {
  const migration = fs.readFileSync(
    new URL("../migrations/0015_collector_health_watchdog.sql", import.meta.url),
    "utf8"
  );
  assert.match(migration, /collector_health[\s\S]*CHECK \(id = 1\)/);
  assert.match(migration, /daily_capture_checks[\s\S]*show_date TEXT PRIMARY KEY/);
  assert.match(migration, /daily_capture_checks_status_date_idx/);
});
