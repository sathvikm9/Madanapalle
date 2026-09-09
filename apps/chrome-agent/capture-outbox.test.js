import assert from "node:assert/strict";
import test from "node:test";
import {
  captureKind,
  createCaptureOutboxEntry,
  orderedCaptureOutbox,
  protectedCaptureAt
} from "./capture-outbox.js";

const show = {
  naturalKey: "SKMD:20260908:1100:1:movie",
  venueCode: "SKMD",
  dateCode: "20260908",
  showTimeLabel: "11:00 AM",
  captureAt: "2026-09-08T05:40:00.000Z",
  finalCaptureAt: "2026-09-08T05:44:00.000Z",
  cutoffAt: "2026-09-08T05:45:00.000Z",
  attemptId: "attempt-1"
};

test("creates a durable entry with one stable upload ID", () => {
  const entry = createCaptureOutboxEntry(show, {
    naturalKey: show.naturalKey,
    attemptId: show.attemptId,
    capturedAt: "2026-09-08T05:40:10.000Z",
    categories: [{ name: "Reserved", sold: 1 }]
  }, "2026-09-08T05:40:11.000Z");
  assert.equal(entry.clientCaptureId, "attempt-1");
  assert.equal(entry.payload.clientCaptureId, "attempt-1");
  assert.equal(entry.payload.queuedAt, "2026-09-08T05:40:11.000Z");
  assert.equal(entry.show.naturalKey, show.naturalKey);
});

test("orders delayed uploads by the time the seats were captured", () => {
  const entries = orderedCaptureOutbox({
    final: { clientCaptureId: "final", payload: { capturedAt: "2026-09-08T05:44:10.000Z" } },
    backup: { clientCaptureId: "backup", payload: { capturedAt: "2026-09-08T05:40:10.000Z" } }
  });
  assert.deepEqual(entries.map((entry) => entry.clientCaptureId), ["backup", "final"]);
});

test("a locally protected capture is equivalent to an uploaded one for scheduling", () => {
  assert.equal(protectedCaptureAt({ lastLocalCaptureAt: "2026-09-08T05:44:10.000Z" }), 1788846250000);
  assert.equal(protectedCaptureAt({
    lastSuccessAt: "2026-09-08T05:40:10.000Z",
    lastLocalCaptureAt: "2026-09-08T05:44:10.000Z"
  }), 1788846250000);
});

test("labels queued backup and final results from their original capture time", () => {
  assert.equal(captureKind(show, { capturedAt: "2026-09-08T05:40:10.000Z" }), "Backup");
  assert.equal(captureKind(show, { capturedAt: "2026-09-08T05:44:10.000Z" }), "Final");
  assert.equal(captureKind(show, {
    capturedAt: "2026-09-08T05:40:10.000Z",
    housefullEvidence: { confirmationCount: 2 }
  }), "Verified housefull");
  assert.equal(captureKind(show, {
    capturedAt: "2026-09-08T05:40:10.000Z",
    captureMethod: "ticketnew-summary-estimate",
    summaryPhase: "backup"
  }), "Backup estimate");
  assert.equal(captureKind(show, {
    capturedAt: "2026-09-08T05:44:10.000Z",
    captureMethod: "ticketnew-summary-estimate",
    summaryPhase: "final"
  }), "Final estimate");
});
