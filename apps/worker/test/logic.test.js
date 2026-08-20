import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCapture, normalizeDiscovery, validDate } from "../src/logic.js";

const discoveryBody = {
  venueCode: "SKMD",
  dateCode: "20260820",
  shows: [{
    eventCode: "ET00510230",
    sessionId: "6220",
    showTimeCode: "1100",
    showTimeLabel: "11:00 AM",
    showDateTime: "202608201100",
    cutoffDateTime: "202608201115",
    movieTitle: "Vishwanath and Sons",
    movieVariant: "Vishwanath and Sons (Telugu)",
    language: "Telugu",
    format: "2D",
    categories: [
      { name: "Reserved", priceCode: "RES", listPricePaise: 10500 },
      { name: "Second Class", priceCode: "SEC", listPricePaise: 8400 }
    ]
  }]
};

test("normalizes a local discovery for D1 using UTC-sortable timestamps", () => {
  const result = normalizeDiscovery(discoveryBody);
  assert.equal(result.shows[0].naturalKey, "SKMD:20260820:1100:6220:ET00510230");
  assert.equal(result.shows[0].startAt, "2026-08-20T05:30:00.000Z");
  assert.equal(result.shows[0].captureAt, "2026-08-20T05:40:00.000Z");
  assert.equal(result.shows[0].cutoffAt, "2026-08-20T05:45:00.000Z");
});

test("normalizes Ravi using its live per-session cutoff", () => {
  const result = normalizeDiscovery({
    ...discoveryBody,
    venueCode: "RTDM",
    shows: [{
      ...discoveryBody.shows[0],
      sessionId: "16642",
      cutoffDateTime: "202608201120"
    }]
  });
  assert.equal(result.shows[0].naturalKey, "RTDM:20260820:1100:16642:ET00510230");
  assert.equal(result.shows[0].venueName, "Ravi A/C 4K Laser Dolby Surround 7.1: Madanapalle");
  assert.equal(result.shows[0].captureAt, "2026-08-20T05:45:00.000Z");
  assert.equal(result.shows[0].cutoffAt, "2026-08-20T05:50:00.000Z");
});

test("normalizes ASR with the Sri Krishna capture window", () => {
  const result = normalizeDiscovery({
    ...discoveryBody,
    venueCode: "ASRM",
    shows: [{ ...discoveryBody.shows[0], sessionId: "7720" }]
  });
  assert.equal(result.shows[0].venueName, "ASR A/C 4K Laser Dolby Surround 7.1: Madanapalle");
  assert.equal(result.shows[0].captureAt, "2026-08-20T05:40:00.000Z");
  assert.equal(result.shows[0].cutoffAt, "2026-08-20T05:45:00.000Z");
});

test("normalizes Sai Chitra TicketNew discovery and validates its cinema URL", () => {
  const result = normalizeDiscovery({
    ...discoveryBody,
    venueCode: "SCM",
    shows: [{
      ...discoveryBody.shows[0],
      eventCode: "OBAV6L",
      sessionId: "34956__1787301900__753__1867461",
      seatLayoutUrl: "https://ticketnew.com/movies/madanapalle/sai-chitra-theatre-a-c-4k-dolby-surround-7-1-madanapalle-c/4903?fromdate=2026-08-20"
    }]
  });
  assert.equal(result.shows[0].venueName, "Sai Chitra Theatre A/C 4K Laser Dolby Surround 7.1: Madanapalle");
  assert.equal(result.shows[0].captureAt, "2026-08-20T05:40:00.000Z");
  assert.match(result.shows[0].seatLayoutUrl, /^https:\/\/ticketnew\.com\/.*\/4903\?/);
  assert.throws(() => normalizeDiscovery({
    ...discoveryBody,
    venueCode: "SCM",
    shows: [{ ...discoveryBody.shows[0], seatLayoutUrl: "https://example.com/4903" }]
  }), /configured TicketNew cinema/);
});

test("rejects discoveries for unconfigured theatres", () => {
  assert.throws(() => normalizeDiscovery({ ...discoveryBody, venueCode: "UNKNOWN" }), /not configured/);
});

test("rejects duplicate slots and non-calendar dates", () => {
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(validDate("2028-02-29"), true);
  assert.throws(() => normalizeDiscovery({
    ...discoveryBody,
    shows: [discoveryBody.shows[0], { ...discoveryBody.shows[0], sessionId: "different" }]
  }), /Duplicate showtime slot/);
});

test("server recalculates the capture with five rupees removed per category", () => {
  const show = {
    id: 1,
    natural_key: "SKMD:20260820:1100:6220:ET00510230",
    is_current: 1,
    capture_at: "2026-08-20T05:40:00.000Z",
    cutoff_at: "2026-08-20T05:45:00.000Z"
  };
  const result = normalizeCapture({
    naturalKey: show.natural_key,
    capturedAt: "2026-08-20T05:44:15.000Z",
    categories: [
      { name: "Reserved", price: 105, capacity: 100, available: 60, sold: 40, unknown: 0 },
      { name: "Second Class", price: 84, capacity: 50, available: 40, sold: 10, unknown: 0 }
    ]
  }, show, new Date("2026-08-20T05:44:16.000Z"));
  assert.equal(result.sold, 50);
  assert.equal(result.collectionPaise, 479000);
  assert.deepEqual(result.categories.map((category) => category.netPricePaise), [10000, 7900]);
});

test("rejects captures with mismatched seat totals", () => {
  const show = {
    natural_key: "key",
    is_current: 1,
    capture_at: "2026-08-20T05:40:00.000Z",
    cutoff_at: "2026-08-20T05:45:00.000Z"
  };
  assert.throws(() => normalizeCapture({
    naturalKey: "key",
    capturedAt: "2026-08-20T05:44:15.000Z",
    categories: [{ name: "Reserved", price: 105, capacity: 100, available: 60, sold: 39, unknown: 0 }]
  }, show, new Date("2026-08-20T05:44:16.000Z")), /do not match capacity/);
});

test("accepts a Sri Krishna backup at 11:10 and rejects anything earlier", () => {
  const show = {
    natural_key: "key",
    is_current: 1,
    capture_at: "2026-08-20T05:40:00.000Z",
    cutoff_at: "2026-08-20T05:45:00.000Z"
  };
  const body = {
    naturalKey: "key",
    capturedAt: "2026-08-20T05:40:05.000Z",
    categories: [{ name: "Reserved", price: 105, capacity: 100, available: 60, sold: 40, unknown: 0 }]
  };
  assert.equal(normalizeCapture(body, show, new Date("2026-08-20T05:40:06.000Z")).sold, 40);
  assert.throws(
    () => normalizeCapture({ ...body, capturedAt: "2026-08-20T05:39:59.000Z" }, show, new Date("2026-08-20T05:40:00.000Z")),
    /configured booking window/
  );
});
