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
