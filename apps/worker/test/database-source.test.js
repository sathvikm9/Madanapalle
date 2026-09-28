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

test("discovery pairs a delayed shifted show with its removed predecessor", () => {
  const source = fs.readFileSync(databaseUrl, "utf8");
  const start = source.indexOf("export async function reconcileDiscovery");
  const end = source.indexOf("export async function currentShow", start);
  const reconcile = source.slice(start, end);

  assert.match(reconcile, /previous\.status='removed'/);
  assert.match(reconcile, /replacement\.previous_show_id=previous\.id/);
  assert.match(reconcile, /const delayed = classifyScheduleChanges/);
  assert.match(reconcile, /replaced: \[\.\.\.classified\.replaced, \.\.\.delayed\.replaced\]/);
  assert.match(reconcile, /DELETE FROM schedule_events[\s\S]*event_type='removed'[\s\S]*previous_show_id=\?/);
});

test("schedule audit exposes both sides of a shifted showtime", () => {
  const source = fs.readFileSync(databaseUrl, "utf8");

  assert.match(source, /previous\.show_time_label AS previous_show_time/);
  assert.match(source, /next_show\.show_time_label AS next_show_time/);
  assert.match(source, /events\.event_type IN \('replaced','removed','added'\)/);
  assert.match(source, /reconcileHistoricalScheduleChanges/);
  assert.match(source, /previousShowTime: event\.previous_show_time/);
  assert.match(source, /nextShowTime: event\.next_show_time/);
});
