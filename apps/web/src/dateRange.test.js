import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRST_LIVE_DATE,
  clampDashboardDate,
  indiaToday,
  millisecondsUntilNextIndiaMidnight,
  reconcileDashboardDate,
  shiftDashboardDate
} from "./dateRange.js";

test("India today rolls forward only at midnight in Asia/Kolkata", () => {
  assert.equal(indiaToday(new Date("2026-08-28T18:29:59.000Z")), "2026-08-28");
  assert.equal(indiaToday(new Date("2026-08-28T18:30:00.000Z")), "2026-08-29");
  assert.equal(millisecondsUntilNextIndiaMidnight(new Date("2026-08-28T18:29:59.000Z")), 1_000);
});

test("dashboard dates are limited to launch day through India today", () => {
  assert.equal(FIRST_LIVE_DATE, "2026-08-21");
  assert.equal(clampDashboardDate("2026-08-20", "2026-08-28"), "2026-08-21");
  assert.equal(clampDashboardDate("2026-08-21", "2026-08-28"), "2026-08-21");
  assert.equal(clampDashboardDate("2026-08-27", "2026-08-28"), "2026-08-27");
  assert.equal(clampDashboardDate("2026-08-29", "2026-08-28"), "2026-08-28");
  assert.equal(clampDashboardDate("invalid", "2026-08-28"), "2026-08-28");
});

test("date navigation stays within launch day and India today", () => {
  assert.equal(shiftDashboardDate("2026-08-21", -1, "2026-08-28"), "2026-08-21");
  assert.equal(shiftDashboardDate("2026-08-22", -1, "2026-08-28"), "2026-08-21");
  assert.equal(shiftDashboardDate("2026-08-27", 1, "2026-08-28"), "2026-08-28");
  assert.equal(shiftDashboardDate("2026-08-28", 1, "2026-08-28"), "2026-08-28");
  assert.equal(shiftDashboardDate("2026-08-31", 1, "2026-09-01"), "2026-09-01");
});

test("foreground reconciliation follows India today across midnight", () => {
  assert.deepEqual(reconcileDashboardDate({
    selectedDate: "2026-09-19",
    latestDate: "2026-09-19",
    currentIndiaDate: "2026-09-20"
  }), {
    dateChanged: true,
    selectedDateChanged: true,
    latestDate: "2026-09-20",
    selectedDate: "2026-09-20"
  });
});

test("foreground reconciliation preserves an intentionally selected historical date", () => {
  assert.deepEqual(reconcileDashboardDate({
    selectedDate: "2026-09-18",
    latestDate: "2026-09-19",
    currentIndiaDate: "2026-09-20"
  }), {
    dateChanged: true,
    selectedDateChanged: false,
    latestDate: "2026-09-20",
    selectedDate: "2026-09-18"
  });
});
