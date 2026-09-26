import assert from "node:assert/strict";
import test from "node:test";
import {
  attemptSecondOffset,
  canPauseVenueDiscovery,
  captureDeadline,
  nextCaptureWhen,
  preflightTimes
} from "./schedule.js";

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

test("uses the five-second offset for Sai Chitra and BookMyShow captures", () => {
  assert.equal(attemptSecondOffset(saiChitra), 5_000);
  assert.equal(attemptSecondOffset(sriKrishna), 5_000);
});

test("schedules Sai Chitra backup at 11:10:05 and final at 11:14:05", () => {
  assert.equal(
    nextCaptureWhen(saiChitra, {}, new Date("2026-09-07T05:35:00.000Z").getTime()),
    new Date("2026-09-07T05:40:05.000Z").getTime()
  );
  assert.equal(
    nextCaptureWhen(saiChitra, {
      lastAttemptAt: "2026-09-07T05:40:05.000Z",
      lastSuccessAt: "2026-09-07T05:40:10.000Z"
    }, new Date("2026-09-07T05:41:00.000Z").getTime()),
    new Date("2026-09-07T05:44:05.000Z").getTime()
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

test("immediately schedules BookMyShow recovery after every failed final attempt", () => {
  const state = {
    recoveryMode: true,
    lastAttemptAt: "2026-08-20T05:44:05.000Z",
    lastSuccessAt: "2026-08-20T05:40:28.000Z"
  };
  assert.equal(
    nextCaptureWhen(sriKrishna, state, new Date("2026-08-20T05:44:26.000Z").getTime()),
    new Date("2026-08-20T05:44:27.000Z").getTime()
  );
  assert.equal(
    nextCaptureWhen(sriKrishna, state, new Date("2026-08-20T05:45:30.000Z").getTime()),
    new Date("2026-08-20T05:45:31.000Z").getTime()
  );
  assert.equal(
    nextCaptureWhen(sriKrishna, {
      ...state,
      lastAttemptAt: "2026-08-20T05:45:10.000Z",
      finalRecoveryAttemptCount: 2
    }, new Date("2026-08-20T05:45:30.000Z").getTime()),
    new Date("2026-08-20T05:45:31.000Z").getTime()
  );
});

test("BookMyShow recovery keeps retrying until the grace deadline", () => {
  const recovery = {
    recoveryMode: true,
    lastAttemptAt: "2026-08-20T05:44:05.000Z",
    lastSuccessAt: "2026-08-20T05:40:28.000Z"
  };
  assert.equal(
    captureDeadline(sriKrishna, recovery),
    new Date("2026-08-20T05:46:00.000Z").getTime()
  );
  assert.equal(
    nextCaptureWhen(sriKrishna, recovery, new Date("2026-08-20T05:46:00.000Z").getTime()),
    null
  );
  assert.equal(
    nextCaptureWhen(sriKrishna, {
      ...recovery,
      lastAttemptAt: "2026-08-20T05:44:27.000Z",
      finalRecoveryAttemptCount: 1
    }, new Date("2026-08-20T05:44:30.000Z").getTime()),
    new Date("2026-08-20T05:44:31.000Z").getTime()
  );
  assert.equal(
    captureDeadline(saiChitra, { recoveryMode: true }),
    new Date("2026-09-07T05:45:00.000Z").getTime()
  );
});

test("simultaneous Ravi and ASR final failures receive independent recovery alarms", () => {
  const now = new Date("2026-08-20T16:34:25.000Z").getTime();
  const shared = {
    platform: "bookmyshow",
    captureAt: "2026-08-20T16:30:00.000Z",
    finalCaptureAt: "2026-08-20T16:34:00.000Z",
    cutoffAt: "2026-08-20T16:35:00.000Z"
  };
  const state = {
    recoveryMode: true,
    lastAttemptAt: "2026-08-20T16:34:05.000Z",
    lastSuccessAt: "2026-08-20T16:30:15.000Z"
  };

  assert.equal(nextCaptureWhen({ ...shared, venueCode: "RTDM" }, state, now), now + 1_000);
  assert.equal(nextCaptureWhen({ ...shared, venueCode: "ASRM" }, state, now), now + 1_000);
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
