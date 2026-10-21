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
  const alarms = source.match(/async function handleAlarm\(alarm\)[\s\S]*?if \(!enabled\) return/)?.[0];

  assert.match(source, /ensurePeriodicAlarm\(CAPTURE_OUTBOX_ALARM,\s*1\)/);
  assert.match(alarms, /alarm\.name === CAPTURE_OUTBOX_ALARM[\s\S]*await flushCaptureOutbox\(\)[\s\S]*const \{ enabled = false \}/);
});

test("collector sends a lightweight authenticated heartbeat every two minutes", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  assert.match(source, /COLLECTOR_HEARTBEAT_PERIOD_MINUTES\s*=\s*2/);
  assert.match(source, /ensurePeriodicAlarm\(COLLECTOR_HEARTBEAT_ALARM, COLLECTOR_HEARTBEAT_PERIOD_MINUTES\)/);
  assert.match(source, /apiPost\("\/api\/agent\/heartbeat"/);
  assert.match(source, /agentVersion:\s*chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(source, /pendingUploads:\s*Object\.keys\(captureOutbox\)\.length/);
  assert.match(source, /async function sendCollectorHeartbeat[\s\S]*collectorRuntimeSettings\(\)/);
});

test("periodic alarm decisions avoid identity migration and shared synced state", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const alarmHandler = source.match(/async function handleAlarm\(alarm\)[\s\S]*?\n}\n\nasync function handleMessage/)?.[0] || "";

  assert.match(alarmHandler, /chrome\.storage\.local\.get\(\{ enabled: false \}\)/);
  assert.doesNotMatch(alarmHandler, /collectorSettings\(\)/);
  assert.doesNotMatch(alarmHandler, /ensureAgentIdentity\(\)/);
});

test("service-worker startup and the upload alarm repair a missing heartbeat schedule", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const alarms = source.match(/async function handleAlarm\(alarm\)[\s\S]*?if \(!enabled\) return/)?.[0];
  const runStart = source.indexOf('if (message.type === "RUN_DISCOVERY")');
  const runEnd = source.indexOf('if (message.type === "CAPTURE_RESULT")', runStart);
  const runDiscovery = source.slice(runStart, runEnd);

  assert.match(source, /void ensureBaseAlarms\(\)\.catch/);
  assert.match(source, /async function ensurePeriodicAlarm[\s\S]*chrome\.alarms\.get\(name\)/);
  assert.match(alarms, /CAPTURE_OUTBOX_ALARM[\s\S]*await flushCaptureOutbox\(\)[\s\S]*await ensureCollectorHeartbeatFresh\(\)/);
  assert.match(source, /COLLECTOR_HEARTBEAT_WATCHDOG_MS\s*=\s*90 \* 1000/);
  assert.match(source, /CHROME_ALARM_START_DELAY_MS\s*=\s*30 \* 1000/);
  assert.match(source, /when:\s*Date\.now\(\) \+ CHROME_ALARM_START_DELAY_MS/);
  assert.match(source, /baseAlarmScheduleVersion !== BASE_ALARM_SCHEDULE_VERSION[\s\S]*chrome\.alarms\.clear\(COLLECTOR_HEARTBEAT_ALARM\)/);
  assert.doesNotMatch(source, /delayInMinutes:\s*0\.1/);
  assert.match(runDiscovery, /await ensureBaseAlarms\(\)/);
});

test("active theatre tabs keep the collector worker alive without affecting Off laptops", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const contentSource = fs.readFileSync(contentUrl, "utf8");

  assert.match(contentSource, /COLLECTOR_KEEPALIVE_INTERVAL_MS\s*=\s*20 \* 1000/);
  assert.match(contentSource, /chrome\.storage\.local\.get\(\{ enabled: false \}\)/);
  assert.match(contentSource, /chrome\.runtime\.connect\(\{ name: COLLECTOR_KEEPALIVE_PORT \}\)/);
  assert.match(contentSource, /postMessage\(\{ type: "COLLECTOR_KEEPALIVE"/);
  assert.match(source, /chrome\.runtime\.onConnect\.addListener/);
  assert.match(source, /message\?\.type !== "COLLECTOR_KEEPALIVE"/);
  assert.match(source, /ensureCollectorHeartbeatFresh\(\)\.catch/);
  assert.match(source, /autoDiscardable: false/);
});

test("an enabled collector prevents idle system sleep and releases the lock when turned off", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const manifest = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

  assert.ok(manifest.permissions.includes("power"));
  assert.match(source, /chrome\.power\.requestKeepAwake\("system"\)/);
  assert.match(source, /chrome\.power\.releaseKeepAwake\(\)/);
  assert.match(source, /syncSystemAwake\(settings\.enabled\)/);
  assert.match(source, /COLLECTOR_HEARTBEAT_ALARM[\s\S]*?syncSystemAwake\(true\)[\s\S]*?sendCollectorHeartbeat/);
});

test("each laptop keeps its own On Off state and coordinates before opening a seat map", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const settingsImport = source.match(/import \{[^}]*\} from "\.\/agent-settings\.js"/)?.[0] || "";
  assert.match(settingsImport, /collectorSettings/);
  assert.match(settingsImport, /ensureAgentIdentity/);
  assert.doesNotMatch(source, /chrome\.storage\.sync\.get\(\{ enabled:/);
  const beginStart = source.indexOf("async function beginCapture");
  const beginEnd = source.indexOf("function discoveryHousefullResult", beginStart);
  const beginCapture = source.slice(beginStart, beginEnd);
  assert.match(beginCapture, /apiPost\("\/api\/agent\/claim"/);
  assert.ok(beginCapture.indexOf('/api/agent/claim') < beginCapture.indexOf("addPending(pending)"));
  assert.match(beginCapture, /claim\.retryAt/);
});

test("turning a laptop off reports its state and clears only automatic capture work", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  assert.match(source, /typeof message\.enabled === "boolean" \? message\.enabled : settings\.enabled/);
  assert.match(source, /chrome\.storage\.local\.set\(\{ enabled, localSettingsMigrated: true \}\)/);
  assert.match(source, /sendCollectorHeartbeat\(\{ automaticCapture: false \}\)\.catch/);
  assert.match(source, /async function stopAutomaticCaptureWork/);
  assert.match(source, /CAPTURE_OUTBOX_ALARM[\s\S]*?flushCaptureOutbox\(\)[\s\S]*?return/);
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

test("manual discovery verifies every Sai Chitra District live route", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const runStart = source.indexOf('if (message.type === "RUN_DISCOVERY")');
  const runEnd = source.indexOf('if (message.type === "CAPTURE_RESULT")', runStart);
  const runDiscovery = source.slice(runStart, runEnd);

  assert.match(runDiscovery, /await discoverAll\(dateCode, \{ force: true \}\)/);
  assert.match(runDiscovery, /sendCollectorHeartbeat\(\{ automaticCapture: true \}\)/);
  assert.match(runDiscovery, /await primeAllSaiChitraDistrictRoutes\(dateCode\)/);
  assert.match(source, /liveSeatLayoutProvider:\s*"district"/);
});

test("BookMyShow final failure primes and repeatedly schedules bounded recovery captures", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const beginStart = source.indexOf("async function beginCapture");
  const beginEnd = source.indexOf("function discoveryHousefullResult", beginStart);
  const beginCapture = source.slice(beginStart, beginEnd);
  const failureStart = source.indexOf("async function failCapture");
  const failureEnd = source.indexOf("async function captureSaiChitraSummaryEstimate", failureStart);
  const failCapture = source.slice(failureStart, failureEnd);
  const recoveryStart = source.indexOf("async function openRecoverySeatLayout");
  const recoveryEnd = source.indexOf("async function closeRecoveryTab", recoveryStart);
  const openRecovery = source.slice(recoveryStart, recoveryEnd);

  assert.match(beginCapture, /finalRecoveryAttemptCount/);
  assert.match(beginCapture, /captureAttemptTimeouts/);
  assert.match(beginCapture, /isFinalRecovery[\s\S]*?captureDeadlineAt/);
  assert.match(failCapture, /recoveryJustActivated && !protectedFinalWindow/);
  assert.ok(
    failCapture.indexOf("prepareRecoverySeatLayout") < failCapture.indexOf("scheduleShow"),
    "the fresh recovery tab must be primed before its immediate alarm is scheduled"
  );
  assert.match(failCapture, /recoveryTabPrimedAt/);
  assert.match(openRecovery, /await chrome\.tabs\.reload\(tab\.id\)/);
  assert.doesNotMatch(failCapture, /finalRecoveryExhausted/);
});

test("capture failure alerts are deduplicated while intermediate recovery stays silent", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const failureStart = source.indexOf("async function failCapture");
  const failureEnd = source.indexOf("async function captureSaiChitraSummaryEstimate", failureStart);
  const failCapture = source.slice(failureStart, failureEnd);

  assert.match(failCapture, /captureFailureAlertPhase/);
  assert.match(failCapture, /alertPhase/);
  assert.match(failCapture, /acceptedAlertStateField/);
  assert.match(failCapture, /localAlertStateField/);
  assert.match(failCapture, /notifyUser: false/);
});

test("BookMyShow final preflight prepares an inactive standby recovery tab", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const start = source.indexOf('if (alarm.name.startsWith("preflight:")');
  const end = source.indexOf('if (alarm.name.startsWith("capture:"))', start);
  const preflight = source.slice(start, end);

  assert.match(preflight, /isFinalPreflight/);
  assert.match(preflight, /show\.platform === "bookmyshow"/);
  assert.match(preflight, /prepareRecoverySeatLayout\(preparedShow, \{ active: false, replace: true \}\)/);
});

test("Sai Chitra final failure uses a bounded fresh District recovery with diagnostics", () => {
  const source = fs.readFileSync(backgroundUrl, "utf8");
  const beginStart = source.indexOf("async function beginCapture");
  const beginEnd = source.indexOf("function discoveryHousefullResult", beginStart);
  const beginCapture = source.slice(beginStart, beginEnd);
  const failureStart = source.indexOf("async function failCapture");
  const failureEnd = source.indexOf("async function captureSaiChitraSummaryEstimate", failureStart);
  const failCapture = source.slice(failureStart, failureEnd);
  const diagnosticsStart = source.indexOf("async function captureAttemptDiagnostics");
  const diagnosticsEnd = source.indexOf("async function failCapture", diagnosticsStart);
  const diagnostics = source.slice(diagnosticsStart, diagnosticsEnd);

  assert.match(beginCapture, /captureAttemptTimeouts/);
  assert.match(beginCapture, /supportsFinalCaptureRecovery/);
  assert.match(failCapture, /protectedFinalWindow/);
  assert.match(failCapture, /prepareRecoverySeatLayout/);
  assert.match(failCapture, /show\.venueCode === "SCM"/);
  assert.match(diagnostics, /tabUrl/);
  assert.match(diagnostics, /tabStatus/);
  assert.match(diagnostics, /capturePageKind/);
  assert.match(diagnostics, /sessionId/);
});
