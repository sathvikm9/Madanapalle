import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  adoptionStats,
  dispatchNotifications,
  notificationConfig,
  recordPwaInstallation,
  savePushSubscription
} from "../src/notifications.js";

function statementDb({ first = null } = {}) {
  const prepared = [];
  const batches = [];
  return {
    prepared,
    batches,
    prepare(sql) {
      const direct = {
        sql,
        first: async () => first,
        run: async () => ({ success: true })
      };
      return {
        ...direct,
        bind(...values) {
          const statement = {
            sql,
            values,
            first: async () => first,
            run: async () => ({ success: true })
          };
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

test("notification config exposes only the public VAPID key", () => {
  const config = notificationConfig({
    NOTIFICATIONS_ENABLED: "true",
    VAPID_SUBJECT: "mailto:test@example.com",
    VAPID_PUBLIC_KEY: "public-key",
    VAPID_PRIVATE_KEY: "private-key"
  });
  assert.equal(config.available, true);
  assert.equal(config.publicKey, "public-key");
  assert.equal("privateKey" in config, false);
  assert.deepEqual(config.venues.map((venue) => venue.code), ["SKMD", "SCM", "RTDM", "ASRM"]);
});

test("notification feature switch keeps configured push delivery disabled", async () => {
  const env = {
    NOTIFICATIONS_ENABLED: "false",
    VAPID_SUBJECT: "mailto:test@example.com",
    VAPID_PUBLIC_KEY: "public-key",
    VAPID_PRIVATE_KEY: "private-key"
  };
  assert.equal(notificationConfig(env).available, false);
  assert.deepEqual(
    await dispatchNotifications(null, env, new Date("2026-09-27T12:00:00Z")),
    { queued: 0, sent: 0, available: false }
  );
});

test("saving a subscription deduplicates one physical PWA and normalizes filters", async () => {
  const db = statementDb();
  const result = await savePushSubscription(db, {
    installationId: "9cb5ba9a-e47a-4cff-995f-bf27f16fb086",
    platform: "ios",
    subscription: {
      endpoint: "https://push.example/subscription",
      expirationTime: null,
      keys: { p256dh: "p256dh", auth: "auth" }
    },
    preferences: {
      venues: ["SKMD", "SKMD", "INVALID"],
      types: ["period_results", "invalid"]
    }
  }, new Date("2026-09-27T12:00:00Z"));

  assert.deepEqual(result.preferences, { venues: ["SKMD"], types: ["period_results"] });
  assert.equal(db.batches.length, 1);
  const batchSql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(batchSql, /INSERT INTO push_subscriptions/);
  assert.match(batchSql, /INSERT INTO pwa_installations/);
  assert.match(batchSql, /notification_enabled=1/);
});

test("standalone PWA launches are counted once per installation ID", async () => {
  const db = statementDb();
  await recordPwaInstallation(db, {
    installationId: "9cb5ba9a-e47a-4cff-995f-bf27f16fb086",
    platform: "android",
    source: "standalone_launch"
  }, new Date("2026-09-27T12:00:00Z"));
  assert.match(db.prepared[0].sql, /ON CONFLICT\(installation_id\) DO UPDATE/);
  assert.equal(db.prepared[0].values[0], "9cb5ba9a-e47a-4cff-995f-bf27f16fb086");
});

test("adoption totals expose aggregate installs and enabled devices only", async () => {
  const db = statementDb({ first: { installed_pwas: 5, notifications_enabled: 4 } });
  assert.deepEqual(await adoptionStats(db), { installedPwas: 5, notificationsEnabled: 4 });
});

test("notification dispatcher is event-driven and uses indexed pending work", () => {
  const source = fs.readFileSync(new URL("../src/notifications.js", import.meta.url), "utf8");
  assert.match(source, /FROM notification_events\s+WHERE status='pending' AND due_at<=\?/);
  assert.match(source, /FROM push_deliveries deliveries[\s\S]*deliveries\.next_attempt_at<=\?/);
  assert.doesNotMatch(source, /SELECT DISTINCT show_date FROM shows/);
  assert.match(source, /if \(!events\.length\) return \{ processed: 0, queued: 0, available: true \}/);
});

test("daily summary is scheduled one minute after the selected day completes", () => {
  const source = fs.readFileSync(new URL("../src/notifications.js", import.meta.url), "utf8");
  assert.match(source, /completedAt \+ DAILY_SUMMARY_GAP_MS/);
  assert.match(source, /const DAILY_SUMMARY_GAP_MS = 60_000/);
});

test("capture failure alerts are urgent, theatre-filtered, and use exact titles", () => {
  const source = fs.readFileSync(new URL("../src/notifications.js", import.meta.url), "utf8");
  assert.match(source, /event_type === "capture_alert"/);
  assert.match(source, /preferences\.venues\.includes\(venueCode\)/);
  assert.match(source, /capture failed - CHECK NOW/);
  assert.match(source, /final capture failed/);
  assert.match(source, /delivery\.notification_type === "capture_alert"/);
  assert.match(source, /urgency: urgent \? "high" : "normal"/);
});
