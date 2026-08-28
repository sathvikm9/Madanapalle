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
