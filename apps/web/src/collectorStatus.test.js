import assert from "node:assert/strict";
import test from "node:test";
import {
  collectorIndicatorLabel,
  collectorOfflineMessage,
  collectorRelativeTime,
  collectorStatusLabel,
  collectorStatusTone
} from "./collectorStatus.js";

test("collector relative time stays compact for a PWA warning", () => {
  const now = new Date("2026-10-18T12:30:00.000Z");
  assert.equal(collectorRelativeTime("2026-10-18T12:04:00.000Z", now), "26 minutes ago");
  assert.equal(collectorRelativeTime("2026-10-18T11:20:00.000Z", now), "1 hour ago");
});

test("collector labels and warnings distinguish online from offline", () => {
  assert.equal(collectorIndicatorLabel({ status: "online", minutesSinceLastSeen: 1 }), "Collector live");
  assert.equal(collectorStatusLabel({ status: "online", minutesSinceLastSeen: 1 }), "Live");
  assert.equal(collectorStatusTone({ status: "online", minutesSinceLastSeen: 1 }), "online");
  assert.equal(collectorIndicatorLabel({ status: "online", minutesSinceLastSeen: 9 }), "Collector delayed");
  assert.equal(collectorStatusLabel({ status: "online", minutesSinceLastSeen: 9 }), "Delayed");
  assert.equal(collectorStatusTone({ status: "online", minutesSinceLastSeen: 9 }), "delayed");
  assert.equal(collectorStatusLabel(null), "Not connected");
  assert.equal(collectorOfflineMessage({ status: "online" }), null);
  assert.match(
    collectorOfflineMessage(
      { status: "offline", lastSeenAt: "2026-10-18T12:04:00.000Z" },
      new Date("2026-10-18T12:30:00.000Z")
    ),
    /Last seen 26 minutes ago.*Open the collector laptop/
  );
});
