import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const databaseUrl = new URL("../src/database.js", import.meta.url);

test("finalizing a protected backup preserves the last failed-final diagnostic", () => {
  const source = fs.readFileSync(databaseUrl, "utf8");
  const start = source.indexOf("export async function finalizeExpiredShows");
  const end = source.indexOf("export async function dashboardData", start);
  const finalize = source.slice(start, end);

  assert.match(finalize, /THEN last_error ELSE COALESCE\(last_error, 'No successful capture before cutoff'\)/);
  assert.doesNotMatch(finalize, /THEN NULL ELSE COALESCE\(last_error/);
});
