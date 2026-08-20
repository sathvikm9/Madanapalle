import assert from "node:assert/strict";
import test from "node:test";
import { nextCaptureWhen, preflightTimes } from "./schedule.js";

const sriKrishna = {
  captureAt: "2026-08-20T05:40:00.000Z",
  cutoffAt: "2026-08-20T05:45:00.000Z"
};

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

test("after a failed backup retries in the next minute", () => {
  assert.equal(
    nextCaptureWhen(sriKrishna, {
      lastAttemptAt: "2026-08-20T05:40:07.000Z"
    }, new Date("2026-08-20T05:40:35.000Z").getTime()),
    new Date("2026-08-20T05:41:05.000Z").getTime()
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
