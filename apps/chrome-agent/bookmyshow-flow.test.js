import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const content = fs.readFileSync(new URL("./content.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

test("loads the BookMyShow React bridge in the page main world before capture", () => {
  const bridge = manifest.content_scripts.find((entry) => entry.js?.includes("bookmyshow-main.js"));
  assert.ok(bridge);
  assert.equal(bridge.world, "MAIN");
  assert.equal(bridge.run_at, "document_start");
  assert.deepEqual(bridge.matches, ["https://in.bookmyshow.com/*"]);
});

test("verifies every BookMyShow transition instead of blindly advancing", () => {
  const prepare = content.slice(
    content.indexOf("async function prepareBookMyShowSeatControls"),
    content.indexOf("function currentBookMyShowControls")
  );
  assert.match(prepare, /selectedCount === 1/);
  assert.match(prepare, /set_quantity_one/);
  assert.match(prepare, /select_seats/);
  assert.match(prepare, /open_accessibility/);
  assert.match(prepare, /actionTrace/);
});

test("counts only the exact BMS row that committed in accessibility mode", () => {
  const capture = content.slice(
    content.indexOf("async function captureSeats"),
    content.indexOf("async function captureTicketNewSeats")
  );
  assert.match(capture, /controls\.rowSelect\?\.value !== row\.value/);
  assert.match(capture, /`Seats for Row \$\{row\.value\}`/);
  assert.match(capture, /commitBookMyShowSelect/);
});

test("commits BookMyShow category and row changes in the page main world", () => {
  assert.match(content, /requestBookMyShowMainAction\("set_select"/);
  assert.match(content, /for \(const method of \["native", "react", "native"\]\)/);
  assert.match(content, /`commit_\$\{control\}`/);
});

test("exposes capture progress and accepts an explicit background start acknowledgement", () => {
  assert.match(content, /message\.type === "START_CAPTURE"/);
  assert.match(content, /activeCaptureAttemptId === pending\.attemptId/);
  assert.match(content, /captureProgress/);
  assert.match(content, /reload_bookmyshow_loading_shell/);
  assert.doesNotMatch(content, /await new Promise\(\(\) => \{\}\)/);
});
