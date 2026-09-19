import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldAutoRefreshDashboard,
  TODAY_REFRESH_INTERVAL_MS
} from "./dashboardRefresh.js";

test("today refreshes every sixty seconds only while the page is visible", () => {
  assert.equal(TODAY_REFRESH_INTERVAL_MS, 60_000);
  assert.equal(shouldAutoRefreshDashboard({
    selectedDate: "2026-09-19",
    latestDate: "2026-09-19",
    visibilityState: "visible"
  }), true);
  assert.equal(shouldAutoRefreshDashboard({
    selectedDate: "2026-09-19",
    latestDate: "2026-09-19",
    visibilityState: "hidden"
  }), false);
  assert.equal(shouldAutoRefreshDashboard({
    selectedDate: "2026-09-18",
    latestDate: "2026-09-19",
    visibilityState: "visible"
  }), false);
});
