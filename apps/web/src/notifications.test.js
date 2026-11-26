import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { migrateNotificationPreferences } from "./notifications.js";

test("upgrades the original four-theatre notification choice to all six theatres", () => {
  const migrated = migrateNotificationPreferences({
    venues: ["SKMD", "SCM", "RTDM", "ASRM"],
    types: ["period_results"]
  });
  assert.deepEqual(migrated.venues, ["SKMD", "SCM", "RTDM", "ASRM", "MSDR", "SUTD"]);
});

test("preserves an intentionally selected notification subset", () => {
  const preferences = { venues: ["SKMD", "RTDM"], types: ["schedule_changes"] };
  assert.equal(migrateNotificationPreferences(preferences), preferences);
});

test("adds Sunil to the former five-theatre all-selection", () => {
  const preferences = {
    venues: ["SKMD", "SCM", "RTDM", "ASRM", "MSDR"],
    types: ["daily_summary"]
  };
  assert.deepEqual(migrateNotificationPreferences(preferences).venues, ["SKMD", "SCM", "RTDM", "ASRM", "MSDR", "SUTD"]);
});

test("leaves current six-theatre notification preferences unchanged", () => {
  const preferences = {
    venues: ["SKMD", "SCM", "RTDM", "ASRM", "MSDR", "SUTD"],
    types: ["daily_summary"]
  };
  assert.equal(migrateNotificationPreferences(preferences), preferences);
});

test("the service worker confirms a notification only after displaying it", () => {
  const source = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const displayIndex = source.indexOf("await self.registration.showNotification");
  const receiptIndex = source.indexOf("await confirmDisplayed(payload)");
  assert.ok(displayIndex >= 0);
  assert.ok(receiptIndex > displayIndex);
  assert.match(source, /deliveryReceipt/);
  assert.match(source, /method: "POST"/);
});
