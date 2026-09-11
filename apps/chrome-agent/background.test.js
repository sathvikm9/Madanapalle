import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const backgroundUrl = new URL("./background.js", import.meta.url);
const contentUrl = new URL("./content.js", import.meta.url);

test("venue discovery passes the configured venue code to the content script", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const readVenuePage = source.match(/async function readVenuePage[\s\S]*?\n}\n\nasync function beginCapture/)?.[0];

  assert.ok(readVenuePage, "readVenuePage function should exist");
  assert.match(readVenuePage, /venueCode:\s*venue\.venueCode/);
  assert.doesNotMatch(readVenuePage, /\n\s*venueCode,\n/);
});

test("stores a capture durably before clearing its pending browser attempt", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const captureResult = source.match(/if \(message\.type === "CAPTURE_RESULT"\)[\s\S]*?if \(message\.type === "CAPTURE_ERROR"\)/)?.[0];

  assert.ok(captureResult, "CAPTURE_RESULT handler should exist");
  assert.match(captureResult, /await protectCaptureLocally\(outboxEntry,[\s\S]*?lastLocalCaptureAt:\s*result\.capturedAt[\s\S]*?await removePending\(pending\.naturalKey\)/);
  assert.match(captureResult, /await scheduleShow\(pending\)[\s\S]*?await flushCaptureOutbox\(\)/);
});

test("retries durable uploads every minute even when automatic capture is disabled", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const alarms = source.match(/async function handleAlarm\(alarm\)[\s\S]*?if \(!settings\.enabled\) return/)?.[0];

  assert.match(source, /CAPTURE_OUTBOX_ALARM[\s\S]*periodInMinutes:\s*1/);
  assert.match(alarms, /alarm\.name === CAPTURE_OUTBOX_ALARM[\s\S]*await flushCaptureOutbox\(\)[\s\S]*const settings/);
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

test("Sai Chitra summary fallback is isolated from the live seat-map tab", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const contentSource = fs.readFileSync(contentUrl, "utf8");
  const summaryStart = source.indexOf("async function captureSaiChitraSummaryEstimate");
  const summaryEnd = source.indexOf("async function recordIgnoredLatePageError", summaryStart);
  const summary = source.slice(summaryStart, summaryEnd);

  assert.match(source, /ticketnew-final-summary:/);
  assert.match(summary, /readTicketNewSummaryCapture/);
  assert.match(summary, /captureMethod:\s*TICKETNEW_SUMMARY_METHOD/);
  assert.match(summary, /hasAnyLiveCapture/);
  assert.match(summary, /searchParams\.set\("skctsummary", "1"\)/);
  assert.match(summary, /searchParams\.set\("skctsummaryrun", show\.attemptId\)/);
  assert.match(summary, /chrome\.tabs\.create\(\{ url: url\.toString\(\), active: false, pinned: false \}\)/);
  assert.match(summary, /phase === "final"/);
  assert.match(summary, /chrome\.tabs\.reload\(tab\.id, \{ bypassCache: true \}\)/);
  assert.match(summary, /chrome\.tabs\.remove/);
  assert.match(contentSource, /get\("skctsummary"\) === "1"\) return/);
});
