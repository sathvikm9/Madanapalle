import assert from "node:assert/strict";
import test from "node:test";
import {
  discoveryRetryDelay,
  discoveryTabError,
  isDiscoveryTabFailure,
  tabBelongsToVenue
} from "./tab-health.js";

test("uses bounded 2, 5, then 15 minute discovery retry backoff", () => {
  assert.equal(discoveryRetryDelay(1), 2 * 60_000);
  assert.equal(discoveryRetryDelay(2), 5 * 60_000);
  assert.equal(discoveryRetryDelay(3), 15 * 60_000);
  assert.equal(discoveryRetryDelay(8), 15 * 60_000);
});

test("tags only explicit tab failures for fresh-tab repair", () => {
  const failure = discoveryTabError(new Error("still loading"), "wait_for_complete", { tabId: 42 });
  assert.equal(isDiscoveryTabFailure(failure), true);
  assert.equal(failure.discoveryStage, "wait_for_complete");
  assert.equal(failure.tabId, 42);
  assert.equal(isDiscoveryTabFailure(new Error("API failed")), false);
});

test("recognizes only the configured theatre page as extension-owned", () => {
  const sriKrishna = { venueCode: "SKMD", platform: "bookmyshow" };
  assert.equal(tabBelongsToVenue({
    url: "https://in.bookmyshow.com/cinemas/mdnp/theatre/buytickets/SKMD/20260901"
  }, sriKrishna), true);
  assert.equal(tabBelongsToVenue({
    pendingUrl: "https://in.bookmyshow.com/movies/mdnp/seat-layout/ET1/SKMD/6220/20260901",
    url: "about:blank"
  }, sriKrishna), true);
  assert.equal(tabBelongsToVenue({ url: "https://example.com/private" }, sriKrishna), false);

  assert.equal(tabBelongsToVenue({
    url: "https://ticketnew.com/movies/madanapalle/sai-chitra/4903?fromdate=2026-09-01"
  }, { platform: "ticketnew", cinemaId: 4903 }), true);
});
