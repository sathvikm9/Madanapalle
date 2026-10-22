import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOKMYSHOW_FINAL_PRIMARY_TIMEOUT_MS,
  BOOKMYSHOW_PRIMARY_PAGE_LOAD_TIMEOUT_MS,
  BOOKMYSHOW_PRIMARY_TIMEOUT_MS,
  captureAttemptTimeouts,
  SAI_CHITRA_FINAL_PRIMARY_PAGE_LOAD_TIMEOUT_MS,
  SAI_CHITRA_FINAL_PRIMARY_TIMEOUT_MS,
  SAI_CHITRA_FINAL_RECOVERY_TIMEOUT_MS
} from "./capture-timing.js";

const saiChitra = {
  venueCode: "SCM",
  platform: "ticketnew",
  captureAt: "2026-10-03T05:40:00.000Z",
  finalCaptureAt: "2026-10-03T05:44:00.000Z",
  cutoffAt: "2026-10-03T05:45:00.000Z"
};

const bookMyShow = {
  venueCode: "ASRM",
  platform: "bookmyshow",
  captureAt: "2026-10-03T05:45:00.000Z",
  finalCaptureAt: "2026-10-03T05:49:00.000Z",
  cutoffAt: "2026-10-03T05:50:00.000Z"
};

test("limits the Sai Chitra primary final attempt to fifteen seconds", () => {
  assert.deepEqual(captureAttemptTimeouts(saiChitra, {
    captureMode: "primary",
    deadline: new Date(saiChitra.cutoffAt).getTime(),
    now: new Date("2026-10-03T05:44:05.000Z").getTime()
  }), {
    watchdogDelayMs: SAI_CHITRA_FINAL_PRIMARY_TIMEOUT_MS,
    pageLoadTimeoutMs: SAI_CHITRA_FINAL_PRIMARY_PAGE_LOAD_TIMEOUT_MS
  });
});

test("bounds the fresh Sai Chitra recovery to the final five-second safety buffer", () => {
  assert.deepEqual(captureAttemptTimeouts(saiChitra, {
    captureMode: "recovery",
    deadline: new Date(saiChitra.cutoffAt).getTime(),
    now: new Date("2026-10-03T05:44:21.000Z").getTime()
  }), {
    watchdogDelayMs: SAI_CHITRA_FINAL_RECOVERY_TIMEOUT_MS,
    pageLoadTimeoutMs: 30_000
  });

  assert.deepEqual(captureAttemptTimeouts(saiChitra, {
    captureMode: "recovery",
    deadline: new Date(saiChitra.cutoffAt).getTime(),
    now: new Date("2026-10-03T05:44:30.000Z").getTime()
  }), {
    watchdogDelayMs: 25_000,
    pageLoadTimeoutMs: 25_000
  });
});

test("fails stalled BookMyShow attempts quickly enough to preserve recovery time", () => {
  assert.deepEqual(captureAttemptTimeouts(bookMyShow, {
    captureMode: "primary",
    deadline: new Date(bookMyShow.cutoffAt).getTime(),
    now: new Date("2026-10-03T05:45:05.000Z").getTime()
  }), {
    watchdogDelayMs: BOOKMYSHOW_PRIMARY_TIMEOUT_MS,
    pageLoadTimeoutMs: BOOKMYSHOW_PRIMARY_PAGE_LOAD_TIMEOUT_MS
  });
  assert.deepEqual(captureAttemptTimeouts(bookMyShow, {
    captureMode: "primary",
    deadline: new Date(bookMyShow.cutoffAt).getTime(),
    now: new Date("2026-10-03T05:49:05.000Z").getTime()
  }), {
    watchdogDelayMs: BOOKMYSHOW_FINAL_PRIMARY_TIMEOUT_MS,
    pageLoadTimeoutMs: BOOKMYSHOW_PRIMARY_PAGE_LOAD_TIMEOUT_MS
  });
  assert.deepEqual(captureAttemptTimeouts(bookMyShow, {
    captureMode: "recovery",
    deadline: new Date("2026-10-03T05:51:00.000Z").getTime(),
    now: new Date("2026-10-03T05:49:21.000Z").getTime()
  }), {
    watchdogDelayMs: 18_000,
    pageLoadTimeoutMs: 18_000
  });
});
