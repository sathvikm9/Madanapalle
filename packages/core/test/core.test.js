import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateCollection,
  captureAtFromCutoff,
  classifyScheduleChanges,
  extractAssignedJson,
  parseVenueShowsFromHtml
} from "../src/index.js";

test("subtracts exactly five rupees from each category price", () => {
  const result = calculateCollection([
    { name: "Reserved", price: 105, capacity: 100, available: 40 },
    { name: "Second", price: 84, capacity: 50, available: 40 }
  ]);
  assert.equal(result.sold, 70);
  assert.equal(result.collectionPaise, 60 * 10_000 + 10 * 7_900);
  assert.deepEqual(result.categories.map((item) => item.netPricePaise), [10_000, 7_900]);
});

test("schedules capture one minute before the BookMyShow cutoff", () => {
  assert.equal(captureAtFromCutoff("2026-08-20T05:45:00.000Z", 1), "2026-08-20T05:44:00.000Z");
});

test("extracts JSON without being confused by braces inside strings", () => {
  const html = '<script>window.__INITIAL_STATE__ = {"text":"a { brace }","ok":true}</script>';
  assert.deepEqual(extractAssignedJson(html), { text: "a { brace }", ok: true });
});

test("parses Sri Krishna session, cutoff, prices and direct seat URL", () => {
  const payload = {
    venueShowtimesFunctionalApi: {
      queries: {
        "getShowtimesByVenue-SKMD-20260820": {
          data: {
            showDetailsTransformed: {
              Venues: { VenueName: "Sri Krishna" },
              Event: [{
                EventTitle: "Movie A",
                ChildEvents: [{
                  EventCode: "ET001",
                  EventName: "Movie A - Telugu",
                  EventLanguage: "Telugu",
                  EventDimension: "2D",
                  ShowTimes: [{
                    SessionId: "6220",
                    ShowDateCode: "20260820",
                    ShowDateTime: "202608201100",
                    ShowTimeCode: "1100",
                    ShowTime: "11:00 AM",
                    CutOffDateTime: "202608201115",
                    Categories: [{ PriceDesc: "RESERVED", PriceCode: "1", CurPrice: "105.00" }]
                  }]
                }]
              }]
            }
          }
        }
      }
    }
  };
  const html = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(payload)}</script>`;
  const shows = parseVenueShowsFromHtml(html, {
    venueCode: "SKMD",
    name: "Sri Krishna",
    fallbackCutoffMinutes: 15,
    captureBeforeCutoffMinutes: 1
  }, "20260820");
  assert.equal(shows[0].captureAt, "2026-08-20T05:44:00.000Z");
  assert.equal(shows[0].advertisedCategories[0].listPricePaise, 10_500);
  assert.match(shows[0].seatLayoutUrl, /ET001\/SKMD\/6220\/20260820$/);
});

test("detects a movie replacement in the same showtime slot", () => {
  const changes = classifyScheduleChanges(
    [{ slotKey: "SKMD:20260820:1800", naturalKey: "old", isCurrent: true }],
    [{ slotKey: "SKMD:20260820:1800", naturalKey: "new" }]
  );
  assert.equal(changes.replaced.length, 1);
  assert.equal(changes.added.length, 0);
});
