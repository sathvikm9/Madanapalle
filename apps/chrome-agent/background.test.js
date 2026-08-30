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
