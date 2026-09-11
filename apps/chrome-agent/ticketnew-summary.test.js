import assert from "node:assert/strict";
import test from "node:test";
import {
  finalSummaryWhen,
  hasAnyLiveCapture,
  hasFinalLiveCapture,
  isTicketNewSummary,
  needsBackupSummary,
  TICKETNEW_SUMMARY_METHOD
} from "./ticketnew-summary.js";

const show = {
  venueCode: "SCM",
  platform: "ticketnew",
  captureAt: "2026-09-10T15:55:00.000Z",
  finalCaptureAt: "2026-09-10T15:59:00.000Z",
  cutoffAt: "2026-09-10T16:00:00.000Z"
};

test("schedules the final TicketNew summary ten seconds after the final live attempt", () => {
  assert.equal(finalSummaryWhen(show), new Date("2026-09-10T15:59:10.000Z").getTime());
});

test("takes one backup summary after the first pre-final live failure", () => {
  assert.equal(needsBackupSummary(show, {}, new Date("2026-09-10T15:55:13.000Z").getTime()), true);
  assert.equal(needsBackupSummary(show, {
    summaryBackupAttemptedAt: "2026-09-10T15:55:14.000Z"
  }, new Date("2026-09-10T15:56:13.000Z").getTime()), false);
  assert.equal(needsBackupSummary(show, {}, new Date("2026-09-10T15:59:05.000Z").getTime()), false);
});

test("recognizes estimates without treating them as live captures", () => {
  assert.equal(isTicketNewSummary({ captureMethod: TICKETNEW_SUMMARY_METHOD }), true);
  assert.equal(isTicketNewSummary({}), false);
});

test("skips the final summary only when a final-window live result is protected", () => {
  assert.equal(hasFinalLiveCapture(show, { lastLocalLiveCaptureAt: "2026-09-10T15:55:10.000Z" }), false);
  assert.equal(hasFinalLiveCapture(show, { lastLocalLiveCaptureAt: "2026-09-10T15:59:08.000Z" }), true);
  assert.equal(hasFinalLiveCapture(show, { lastSuccessAt: "2026-09-10T15:59:08.000Z" }), true);
  assert.equal(hasFinalLiveCapture(show, { lastEstimateAt: "2026-09-10T15:59:10.000Z" }), false);
});

test("recognizes any protected in-window live capture as better than a summary estimate", () => {
  assert.equal(hasAnyLiveCapture(show, { lastLocalLiveCaptureAt: "2026-09-10T15:55:10.000Z" }), true);
  assert.equal(hasAnyLiveCapture(show, { lastEstimateAt: "2026-09-10T15:59:10.000Z" }), false);
  assert.equal(hasAnyLiveCapture(show, { lastLocalLiveCaptureAt: "2026-09-10T15:54:59.000Z" }), false);
});
