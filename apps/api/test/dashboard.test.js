import assert from "node:assert/strict";
import test from "node:test";
import { validDate } from "../src/dashboard.js";

test("dashboard accepts only ISO calendar-shaped dates", () => {
  assert.equal(validDate("2026-08-20"), true);
  assert.equal(validDate("20260820"), false);
  assert.equal(validDate("2026-8-20"), false);
});
