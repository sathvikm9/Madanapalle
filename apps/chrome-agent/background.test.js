import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const backgroundUrl = new URL("./background.js", import.meta.url);

test("venue discovery passes the configured venue code to the content script", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const readVenuePage = source.match(/async function readVenuePage[\s\S]*?\n}\n\nasync function beginCapture/)?.[0];

  assert.ok(readVenuePage, "readVenuePage function should exist");
  assert.match(readVenuePage, /venueCode:\s*venue\.venueCode/);
  assert.doesNotMatch(readVenuePage, /\n\s*venueCode,\n/);
});

test("records the successful attempt before clearing its pending capture", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const captureResult = source.match(/if \(message\.type === "CAPTURE_RESULT"\)[\s\S]*?if \(message\.type === "CAPTURE_ERROR"\)/)?.[0];

  assert.ok(captureResult, "CAPTURE_RESULT handler should exist");
  assert.match(captureResult, /lastSuccessAttemptId:\s*pending\.attemptId[\s\S]*?await removePending\(pending\.naturalKey\)/);
});

test("capture alarm checks an attempt-specific success before reporting a page failure", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const start = source.indexOf('if (alarm.name.startsWith("capture:"))');
  const end = source.indexOf('if (alarm.name.startsWith("recovery-cleanup:"))', start);
  const captureAlarm = start >= 0 && end > start ? source.slice(start, end) : "";

  assert.ok(captureAlarm, "capture alarm handler should exist");
  assert.match(captureAlarm, /successfulAttemptAlreadyHandled\(error, state\)/);
  assert.match(captureAlarm, /await failCapture/);
});

test("repairs a failed discovery with a fresh extension-owned tab", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const readVenuePage = source.match(/async function readVenuePage\(venue, dateCode\)[\s\S]*?\n}\n\nasync function readVenuePageOnce/)?.[0];
  const replaceAgentTab = source.match(/async function replaceAgentTab[\s\S]*?\n}\n\nasync function resetAgentTabsForNewDay/)?.[0];

  assert.ok(readVenuePage, "readVenuePage repair wrapper should exist");
  assert.match(readVenuePage, /isDiscoveryTabFailure\(error\)/);
  assert.match(readVenuePage, /await replaceAgentTab\(venue, dateCode\)/);
  assert.match(readVenuePage, /readVenuePageOnce\(venue, dateCode, false\)/);
  assert.ok(replaceAgentTab, "replaceAgentTab should exist");
  assert.match(replaceAgentTab, /tabBelongsToVenue\(oldTab, venue\)/);
  assert.match(replaceAgentTab, /chrome\.tabs\.remove/);
  assert.match(replaceAgentTab, /chrome\.tabs\.create/);
});

test("India day rollover discards stale collector tabs before discovery", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const rolloverStart = source.indexOf("if (alarm.name === INDIA_DAY_ROLLOVER)");
  const rolloverEnd = source.indexOf("if (!settings.enabled) return", rolloverStart);
  const rollover = source.slice(rolloverStart, rolloverEnd);

  assert.match(rollover, /await resetAgentTabsForNewDay\(today\)/);
  assert.match(rollover, /await discoverAll\(today, \{ force: true \}\)/);
  assert.ok(
    rollover.indexOf("resetAgentTabsForNewDay") < rollover.indexOf("discoverAll"),
    "stale tabs should be reset before forced discovery"
  );
});
