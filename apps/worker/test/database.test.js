import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const databaseSource = fs.readFileSync(new URL("../src/database.js", import.meta.url), "utf8");
const migrationSource = fs.readFileSync(new URL("../migrations/0002_capture_outbox_idempotency.sql", import.meta.url), "utf8");

test("capture storage has a unique durable client upload ID", () => {
  assert.match(migrationSource, /ADD COLUMN client_capture_id TEXT/);
  assert.match(migrationSource, /CREATE UNIQUE INDEX[\s\S]*client_capture_id/);
  assert.match(databaseSource, /existingClientCapture/);
  assert.match(databaseSource, /client_capture_id/);
  assert.match(databaseSource, /idempotency_conflict/);
});
