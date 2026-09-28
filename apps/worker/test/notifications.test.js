import assert from "node:assert/strict";
import test from "node:test";
import {
  dailySummaryReady,
  dispatchNotifications,
  notificationConfig,
  savePushSubscription
} from "../src/notifications.js";

function deliveryDb(sentAt) {
  return {
    prepare() {
      return {
        bind() {
          return { first: async () => sentAt ? { sent_at: sentAt } : null };
        }
      };
    }
  };
}

const FINAL_SHOWS = [{
  showTime: "09:20 PM",
  startAt: "2026-09-27T15:50:00.000Z",
  cutoffAt: "2026-09-27T16:10:00.000Z",
  updatedAt: "2026-09-27T16:10:04.000Z",
  snapshot: { capturedAt: "2026-09-27T16:09:00.000Z" }
}];

test("notification config exposes only the public VAPID key", () => {
  const config = notificationConfig({
    VAPID_SUBJECT: "mailto:test@example.com",
    VAPID_PUBLIC_KEY: "public-key",
    VAPID_PRIVATE_KEY: "private-key"
  });
  assert.equal(config.available, true);
  assert.equal(config.publicKey, "public-key");
  assert.equal("privateKey" in config, false);
  assert.deepEqual(config.venues.map((venue) => venue.code), ["SKMD", "SCM", "RTDM", "ASRM"]);
});
test("saving a subscription normalizes theatre and type filters", async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          calls.push({ sql, values });
          return { run: async () => ({ success: true }) };
        }
      };
    }
  };
  const result = await savePushSubscription(db, {
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].values[0], "https://push.example/subscription");
});

test("dispatcher is inert until production VAPID secrets are configured", async () => {
  const result = await dispatchNotifications(null, {}, new Date("2026-09-27T12:00:00Z"));
  assert.deepEqual(result, { queued: 0, available: false });
});

test("daily summary waits one minute after the final period notification was sent", async () => {
  const subscription = { id: 9 };
  const preferences = { types: ["period_results", "daily_summary"] };
  const beforeGap = await dailySummaryReady(
    deliveryDb("2026-09-27T16:10:30.000Z"),
    subscription,
    preferences,
    FINAL_SHOWS,
    "2026-09-27",
    new Date("2026-09-27T16:11:29.000Z")
  );
  const afterGap = await dailySummaryReady(
    deliveryDb("2026-09-27T16:10:30.000Z"),
    subscription,
    preferences,
    FINAL_SHOWS,
    "2026-09-27",
    new Date("2026-09-27T16:11:30.000Z")
  );
  assert.equal(beforeGap, false);
  assert.equal(afterGap, true);
});

test("daily-only subscribers wait one minute after the latest show becomes terminal", async () => {
  const ready = await dailySummaryReady(
    deliveryDb(null),
    { id: 10 },
    { types: ["daily_summary"] },
    FINAL_SHOWS,
    "2026-09-27",
    new Date("2026-09-27T16:11:04.000Z")
  );
  assert.equal(ready, true);
});
