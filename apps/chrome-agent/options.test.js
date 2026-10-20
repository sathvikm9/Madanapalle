import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const options = fs.readFileSync(new URL("./options.js", import.meta.url), "utf8");
const markup = fs.readFileSync(new URL("./options.html", import.meta.url), "utf8");

test("a rejected token returns the laptop to an explicit reconnect screen", () => {
  assert.match(options, /invalidateAgentAuthorization/);
  assert.match(options, /Boolean\(local\.agentToken\) && !local\.agentAuthorizationInvalid/);
  assert.match(options, /Reconnect this laptop/);
  assert.match(options, /protected upload/);
  assert.match(markup, /id="connectTitle"/);
  assert.match(markup, /id="connectHelp"/);
});

test("the On switch and Test now send an explicit active state to the background worker", () => {
  assert.match(options, /type: "SETTINGS_UPDATED", enabled: requestedEnabled/);
  assert.match(options, /type: "RUN_DISCOVERY", automaticCapture: true/);
  assert.match(options, /Collector is On ·/);
  assert.match(options, /Sleep protection active/);
});
