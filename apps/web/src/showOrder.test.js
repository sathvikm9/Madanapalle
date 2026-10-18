import test from "node:test";
import assert from "node:assert/strict";
import { sortShowsForDisplay } from "./showOrder.js";

function show(id, venueCode, startAt) {
  return { id, venueCode, startAt };
}

test("orders shows by time before applying theatre priority", () => {
  const shows = sortShowsForDisplay([
    show("krishna-morning", "SKMD", "2026-10-18T11:00:00+05:30"),
    show("ravi-early", "RTDM", "2026-10-18T07:00:00+05:30"),
    show("asr-early", "ASRM", "2026-10-18T06:00:00+05:30"),
    show("sai-morning", "SCM", "2026-10-18T10:45:00+05:30")
  ]);

  assert.deepEqual(shows.map((item) => item.id), [
    "asr-early",
    "ravi-early",
    "sai-morning",
    "krishna-morning"
  ]);
});

test("uses Ravi, ASR, Sai Chitra, Sri Krishna for matching showtimes", () => {
  const shows = sortShowsForDisplay([
    show("krishna", "SKMD", "2026-10-18T11:00:00+05:30"),
    show("sai", "SCM", "2026-10-18T11:00:00+05:30"),
    show("ravi", "RTDM", "2026-10-18T11:00:00+05:30"),
    show("asr", "ASRM", "2026-10-18T11:00:00+05:30")
  ]);

  assert.deepEqual(shows.map((item) => item.venueCode), ["RTDM", "ASRM", "SCM", "SKMD"]);
});

test("does not mutate the API response array", () => {
  const original = [
    show("krishna", "SKMD", "2026-10-18T11:00:00+05:30"),
    show("ravi", "RTDM", "2026-10-18T11:00:00+05:30")
  ];

  const sorted = sortShowsForDisplay(original);
  assert.notEqual(sorted, original);
  assert.deepEqual(original.map((item) => item.venueCode), ["SKMD", "RTDM"]);
});
