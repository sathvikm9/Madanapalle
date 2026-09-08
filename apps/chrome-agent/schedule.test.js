import assert from "node:assert/strict";
import test from "node:test";
import { attemptSecondOffset, canPauseVenueDiscovery, nextCaptureWhen, preflightTimes } from "./schedule.js";

const sriKrishna = {
  venueCode: "SKMD",
  platform: "bookmyshow",
  captureAt: "2026-08-20T05:40:00.000Z",
  cutoffAt: "2026-08-20T05:45:00.000Z"
};

const saiChitra = {
  venueCode: "SCM",
  platform: "ticketnew",
  captureAt: "2026-09-07T05:40:00.000Z",
  finalCaptureAt: "2026-09-07T05:44:00.000Z",
  cutoffAt: "2026-09-07T05:45:00.000Z"
};

test("uses the 40-second offset only for Sai Chitra TicketNew captures", () => {
  assert.equal(attemptSecondOffset(saiChitra), 40_000);
  assert.equal(attemptSecondOffset(sriKrishna), 5_000);
});

test("schedules Sai Chitra backup at 11:10:40 and final at 11:14:40", () => {
  assert.equal(
    nextCaptureWhen(saiChitra, {}, new Date("2026-09-07T05:35:00.000Z").getTime()),
    new Date("2026-09-07T05:40:40.000Z").getTime()
  );
  assert.equal(
    nextCaptureWhen(saiChitra, {
      lastAttemptAt: "2026-09-07T05:40:40.000Z",
      lastSuccessAt: "2026-09-07T05:40:45.000Z"
    }, new Date("2026-09-07T05:41:00.000Z").getTime()),
    new Date("2026-09-07T05:44:40.000Z").getTime()
  );
});

test("starts Sri Krishna five seconds into the 11:10 backup minute", () => {
  assert.equal(
    nextCaptureWhen(sriKrishna, {}, new Date("2026-08-20T05:35:00.000Z").getTime()),
    new Date("2026-08-20T05:40:05.000Z").getTime()
  );
});

test("after an early success waits for the 11:14 final minute", () => {
  assert.equal(
    nextCaptureWhen(sriKrishna, {
      lastAttemptAt: "2026-08-20T05:40:07.000Z",
      lastSuccessAt: "2026-08-20T05:40:28.000Z"
    }, new Date("2026-08-20T05:40:30.000Z").getTime()),
    new Date("2026-08-20T05:44:05.000Z").getTime()
  );
});

test("a backup saved only in the local outbox still waits for the final minute", () => {
  assert.equal(
    nextCaptureWhen(sriKrishna, {
      lastAttemptAt: "2026-08-20T05:40:07.000Z",
      lastLocalCaptureAt: "2026-08-20T05:40:28.000Z"
    }, new Date("2026-08-20T05:40:30.000Z").getTime()),
    new Date("2026-08-20T05:44:05.000Z").getTime()
  );
});

test("a final capture saved only in the local outbox stops booking-site retries", () => {
  assert.equal(
    nextCaptureWhen(sriKrishna, {
      lastAttemptAt: "2026-08-20T05:44:07.000Z",
      lastLocalCaptureAt: "2026-08-20T05:44:28.000Z"
    }, new Date("2026-08-20T05:44:30.000Z").getTime()),
    null
  );
});

test("after a failed backup retries in the next minute", () => {
  assert.equal(
    nextCaptureWhen(sriKrishna, {
      lastAttemptAt: "2026-08-20T05:40:07.000Z"
    }, new Date("2026-08-20T05:40:35.000Z").getTime()),
    new Date("2026-08-20T05:41:05.000Z").getTime()
  );
});

test("recovery mode keeps the same minute-by-minute retry and final timing", () => {
  const recoveryAfterFailure = {
    recoveryMode: true,
    lastAttemptAt: "2026-08-20T05:40:07.000Z"
  };
  assert.equal(
    nextCaptureWhen(sriKrishna, recoveryAfterFailure, new Date("2026-08-20T05:40:35.000Z").getTime()),
    new Date("2026-08-20T05:41:05.000Z").getTime()
  );

  const protectedRecoveryBackup = {
    ...recoveryAfterFailure,
    lastAttemptAt: "2026-08-20T05:41:05.000Z",
    lastSuccessAt: "2026-08-20T05:41:32.000Z",
    lastRecoverySuccessAt: "2026-08-20T05:41:32.000Z"
  };
  assert.equal(
    nextCaptureWhen(sriKrishna, protectedRecoveryBackup, new Date("2026-08-20T05:42:00.000Z").getTime()),
    new Date("2026-08-20T05:44:05.000Z").getTime()
  );
});

test("does not retry after the final-minute attempt", () => {
  assert.equal(
    nextCaptureWhen(sriKrishna, {
      lastAttemptAt: "2026-08-20T05:44:07.000Z",
      lastSuccessAt: "2026-08-20T05:40:28.000Z"
    }, new Date("2026-08-20T05:44:35.000Z").getTime()),
    null
  );
});

test("schedules backup and final preflights", () => {
  assert.deepEqual(preflightTimes(sriKrishna), [
    new Date("2026-08-20T05:38:30.000Z").getTime(),
    new Date("2026-08-20T05:43:15.000Z").getTime()
  ]);
});

test("pauses routine venue discovery only after its last show was captured", () => {
  const shows = [
    {
      naturalKey: "SKMD:20260820:1100:first",
      captureAt: "2026-08-20T05:40:00.000Z",
      cutoffAt: "2026-08-20T05:45:00.000Z"
    },
    {
      naturalKey: "SKMD:20260820:2100:last",
      captureAt: "2026-08-20T15:40:00.000Z",
      cutoffAt: "2026-08-20T15:45:00.000Z"
    }
  ];
  const captureStates = {
    "SKMD:20260820:2100:last": { lastSuccessAt: "2026-08-20T15:44:20.000Z" }
  };

  assert.equal(canPauseVenueDiscovery(shows, captureStates, new Date("2026-08-20T15:44:59.000Z").getTime()), false);
  assert.equal(canPauseVenueDiscovery(shows, captureStates, new Date("2026-08-20T15:45:01.000Z").getTime()), true);
  assert.equal(canPauseVenueDiscovery(shows, {
    "SKMD:20260820:2100:last": { lastLocalCaptureAt: "2026-08-20T15:44:20.000Z" }
  }, new Date("2026-08-20T15:45:01.000Z").getTime()), true);
  assert.equal(canPauseVenueDiscovery(shows, {}, new Date("2026-08-20T15:45:01.000Z").getTime()), false);
});
