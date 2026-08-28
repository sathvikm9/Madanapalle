import assert from "node:assert/strict";
import test from "node:test";
import { captureModeFor, recoveryChanges, refreshedRecoveryShow, supportsRecovery } from "./recovery.js";

const bookMyShow = (venueCode) => ({ venueCode, platform: "bookmyshow" });

test("enables recovery only for the three configured BookMyShow theatres", () => {
  assert.equal(supportsRecovery(bookMyShow("SKMD")), true);
  assert.equal(supportsRecovery(bookMyShow("RTDM")), true);
  assert.equal(supportsRecovery(bookMyShow("ASRM")), true);
  assert.equal(supportsRecovery({ venueCode: "SCM", platform: "ticketnew" }), false);
  assert.equal(supportsRecovery(bookMyShow("UNKNOWN")), false);
});

test("switches a failed BookMyShow show into persistent recovery mode", () => {
  const first = recoveryChanges(bookMyShow("SKMD"), {}, {
    stage: "wait_select_seats_button",
    error: "Select Seats was missing",
    diagnostics: { pageKind: "bookmyshow_seat_layout" }
  }, new Date("2026-08-28T15:40:30.000Z"));

  assert.equal(first.recoveryMode, true);
  assert.equal(first.recoveryStartedAt, "2026-08-28T15:40:30.000Z");
  assert.equal(first.recoveryFailures, 1);
  assert.equal(first.lastRecoveryPageKind, "bookmyshow_seat_layout");
  assert.equal(captureModeFor(bookMyShow("SKMD"), first), "recovery");

  const second = recoveryChanges(bookMyShow("SKMD"), first, {
    stage: "watchdog_timeout",
    error: "Seat read timed out"
  }, new Date("2026-08-28T15:41:55.000Z"));
  assert.equal(second.recoveryStartedAt, first.recoveryStartedAt);
  assert.equal(second.recoveryFailures, 2);
});

test("does not activate browser recovery for TicketNew or an upload failure", () => {
  assert.equal(recoveryChanges({ venueCode: "SCM", platform: "ticketnew" }, {}, {
    stage: "read_seat_map",
    error: "TicketNew failed"
  }), null);
  assert.equal(recoveryChanges(bookMyShow("RTDM"), {}, {
    stage: "upload_capture",
    error: "API unavailable"
  }), null);
  assert.equal(captureModeFor({ venueCode: "SCM", platform: "ticketnew" }, { recoveryMode: true }), "primary");
});

test("recovery follows a refreshed session in the same theatre slot", () => {
  const failed = { naturalKey: "old", slotKey: "SKMD:20260828:2100" };
  const replacement = { naturalKey: "new", slotKey: "SKMD:20260828:2100" };
  assert.equal(refreshedRecoveryShow(failed, [replacement]), replacement);
  assert.equal(refreshedRecoveryShow(failed, [{ naturalKey: "other", slotKey: "SKMD:20260828:1800" }]), failed);
});
