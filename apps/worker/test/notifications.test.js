import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchNotifications,
  notificationConfig,
  savePushSubscription
} from "../src/notifications.js";

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
