import test from "node:test";
import assert from "node:assert/strict";
import { migrateNotificationPreferences } from "./notifications.js";

test("adds Mini Siddartha to the former all-theatre notification choice", () => {
  const migrated = migrateNotificationPreferences({
    venues: ["SKMD", "SCM", "RTDM", "ASRM"],
    types: ["period_results"]
  });
  assert.deepEqual(migrated.venues, ["SKMD", "SCM", "RTDM", "ASRM", "MSDR"]);
});

test("preserves an intentionally selected notification subset", () => {
  const preferences = { venues: ["SKMD", "RTDM"], types: ["schedule_changes"] };
  assert.equal(migrateNotificationPreferences(preferences), preferences);
});

test("leaves current five-theatre notification preferences unchanged", () => {
  const preferences = {
    venues: ["SKMD", "SCM", "RTDM", "ASRM", "MSDR"],
    types: ["daily_summary"]
  };
  assert.equal(migrateNotificationPreferences(preferences), preferences);
});
