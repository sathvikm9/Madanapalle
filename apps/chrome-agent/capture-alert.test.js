import assert from "node:assert/strict";
import test from "node:test";
import {
  captureFailureAlertPhase,
  captureFailureAlertTitle
} from "./capture-alert.js";

const ravi = {
  venueCode: "RTDM",
  captureAt: "2026-10-07T16:05:00.000Z",
  finalCaptureAt: "2026-10-07T16:09:00.000Z",
  cutoffAt: "2026-10-07T16:10:00.000Z"
};

test("alerts once after the initial failure when no capture is protected", () => {
  assert.equal(
    captureFailureAlertPhase(ravi, {}, "2026-10-07T16:05:05.000Z"),
    "initial"
  );
  assert.equal(
    captureFailureAlertPhase(ravi, {
      initialFailureAlertAcceptedAt: "2026-10-07T16:05:20.000Z"
    }, "2026-10-07T16:06:05.000Z"),
    null
  );
});

test("alerts once after the final failure only when no fallback exists", () => {
  assert.equal(
    captureFailureAlertPhase(ravi, {
      initialFailureAlertAcceptedAt: "2026-10-07T16:05:20.000Z"
    }, "2026-10-07T16:09:05.000Z"),
    "final"
  );
  assert.equal(
    captureFailureAlertPhase(ravi, {
      initialFailureAlertAcceptedAt: "2026-10-07T16:05:20.000Z",
      finalFailureAlertAcceptedAt: "2026-10-07T16:09:25.000Z"
    }, "2026-10-07T16:09:30.000Z"),
    null
  );
  assert.equal(
    captureFailureAlertPhase(ravi, {
      lastLocalCaptureAt: "2026-10-07T16:06:30.000Z"
    }, "2026-10-07T16:09:05.000Z"),
    null
  );
});

test("uses the requested urgent notification titles", () => {
  assert.equal(
    captureFailureAlertTitle("Ravi", "09:20 PM", "initial"),
    "Ravi 9:20 PM capture failed - CHECK NOW"
  );
  assert.equal(
    captureFailureAlertTitle("Ravi", "09:20 PM", "final"),
    "Ravi 9:20 PM final capture failed"
  );
});
