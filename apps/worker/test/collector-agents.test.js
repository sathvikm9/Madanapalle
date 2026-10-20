import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { claimCapture, enrollCollector } from "../src/collector-agents.js";

function claimDb({ snapshot = null, claim = null, preferred = null } = {}) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("FROM snapshots")) return snapshot;
              if (sql.includes("FROM capture_claims")) return claim;
              if (sql.includes("FROM collector_agents")) return preferred;
              return null;
            },
            async run() { writes.push({ sql, values }); return { success: true }; }
          };
        }
      };
    }
  };
}

const show = {
  id: 42,
  capture_at: "2026-10-20T15:00:00.000Z",
  cutoff_at: "2026-10-20T15:05:00.000Z"
};

test("primary collector receives the capture lease", async () => {
  const db = claimDb({ preferred: { agent_id: "home-agent" } });
  const result = await claimCapture(db, { agentId: "home-agent" }, show, "backup", new Date(show.capture_at));
  assert.equal(result.granted, true);
  assert.equal(db.writes.length, 1);
});

test("backup waits fifteen seconds then can take over", async () => {
  const db = claimDb({ preferred: { agent_id: "home-agent" } });
  const waiting = await claimCapture(db, { agentId: "travel-agent" }, show, "backup", new Date(show.capture_at));
  assert.equal(waiting.granted, false);
  assert.equal(waiting.reason, "standby");
  assert.equal(waiting.retryAt, "2026-10-20T15:00:15.000Z");
  const takeover = await claimCapture(db, { agentId: "travel-agent" }, show, "backup", new Date("2026-10-20T15:00:16.000Z"));
  assert.equal(takeover.granted, true);
});

test("existing capture protects the show from duplicate collectors", async () => {
  const db = claimDb({ snapshot: { id: 9 }, preferred: { agent_id: "home-agent" } });
  const result = await claimCapture(db, { agentId: "travel-agent" }, show, "final", new Date("2026-10-20T15:04:00.000Z"));
  assert.deepEqual(result, { granted: false, protected: true, reason: "already_captured" });
});

test("multi collector migration adds identities and capture leases", () => {
  const migration = fs.readFileSync(new URL("../migrations/0016_multi_collector_agents.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS collector_agents/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS capture_claims/);
  assert.match(migration, /collector_agents_capture_priority_idx/);
});

test("reconnecting an existing laptop rotates its token without changing its priority", async () => {
  const writes = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("agent_id=?")) return { role_priority: 10 };
              if (sql.includes("MAX(role_priority)")) return { priority: 40 };
              return null;
            },
            async run() { writes.push({ sql, values }); return { success: true }; }
          };
        },
        async first() {
          if (sql.includes("MAX(role_priority)")) return { priority: 40 };
          return null;
        }
      };
    }
  };

  const result = await enrollCollector(db, { COLLECTOR_SETUP_CODE: "private-code" }, {
    agentId: "existing-laptop",
    name: "Home laptop",
    connectionCode: "private-code"
  }, new Date("2026-10-20T12:00:00.000Z"));

  assert.equal(result.rolePriority, 10);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].values[2], 10);
});
