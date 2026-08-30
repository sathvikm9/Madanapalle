import test from "node:test";
import assert from "node:assert/strict";
import { buildCapacityProfiles, summarizeAnalyticsRows } from "../src/analytics.js";

function row(overrides = {}) {
  return {
    venue_code: "SCM",
    event_code: "IRUMUDI",
    movie_title: "Irumudi",
    movie_variant: "Irumudi",
    show_date: "2026-08-21",
    start_at: "2026-08-21T02:00:00.000Z",
    status: "completed",
    snapshot_id: 1,
    capacity: 424,
    sold: 424,
    collection_paise: 4_015_300,
    ...overrides
  };
}

test("summarizes captured, housefull, gross and theatre coverage", () => {
  const summary = summarizeAnalyticsRows([
    row(),
    row({ venue_code: "ASRM", event_code: "ET1", capacity: 520, sold: 400, collection_paise: 4_000_000 }),
    row({ venue_code: "RTDM", event_code: "ET1", status: "missed", snapshot_id: null, capacity: null, sold: null, collection_paise: null })
  ], {
    movieTitle: "Irumudi",
    startDate: "2026-08-21",
    endDate: "2026-08-27",
    now: new Date("2026-08-28T00:00:00.000Z")
  });

  assert.deepEqual(summary.total, {
    screenedShows: 3,
    capturedShows: 2,
    housefullShows: 1,
    ticketsSold: 824,
    capacity: 944,
    collectionPaise: 8_015_300
  });
  assert.deepEqual(summary.venues.map((venue) => venue.code), ["SCM", "ASRM", "RTDM"]);
  assert.equal(summary.venues[2].capturedShows, 0);
  assert.deepEqual(summary.days.map((day) => day.date), ["2026-08-21"]);
  assert.equal(summary.days[0].collectionPaise, 8_015_300);
});

test("returns day-wise totals across a selected range", () => {
  const summary = summarizeAnalyticsRows([
    row(),
    row({ show_date: "2026-08-22", start_at: "2026-08-22T02:00:00.000Z", sold: 300, collection_paise: 3_000_000 })
  ], {
    movieTitle: "Irumudi",
    venueCode: "ALL",
    startDate: "2026-08-21",
    endDate: "2026-08-22",
    now: new Date("2026-08-23T00:00:00.000Z")
  });

  assert.deepEqual(summary.days.map((day) => day.date), ["2026-08-21", "2026-08-22"]);
  assert.deepEqual(summary.days.map((day) => day.collectionPaise), [4_015_300, 3_000_000]);
});

test("excludes future, other-movie and other-theatre shows", () => {
  const summary = summarizeAnalyticsRows([
    row(),
    row({ start_at: "2026-08-30T18:00:00.000Z" }),
    row({ event_code: "TOXIC", movie_title: "Toxic: A Fairy Tale for Grown-ups" }),
    row({ venue_code: "ASRM" })
  ], {
    movieTitle: "Irumudi",
    venueCode: "SCM",
    startDate: "2026-08-21",
    endDate: "2026-08-30",
    now: new Date("2026-08-30T12:00:00.000Z")
  });

  assert.equal(summary.total.screenedShows, 1);
  assert.equal(summary.total.housefullShows, 1);
});

test("summarizes every movie when the daily report requests ALL", () => {
  const summary = summarizeAnalyticsRows([
    row(),
    row({ event_code: "TOXIC", movie_title: "Toxic: A Fairy Tale for Grown-ups", venue_code: "ASRM", sold: 300, capacity: 520, collection_paise: 3_000_000 })
  ], {
    movieTitle: "ALL",
    venueCode: "ALL",
    startDate: "2026-08-21",
    endDate: "2026-08-21",
    now: new Date("2026-08-22T00:00:00.000Z")
  });

  assert.equal(summary.movieTitle, "All movies");
  assert.equal(summary.total.screenedShows, 2);
  assert.equal(summary.total.collectionPaise, 7_015_300);
  assert.deepEqual(summary.venues.map((venue) => venue.code), ["SCM", "ASRM"]);
});

test("resolves a TicketNew internal event code before grouping", () => {
  const summary = summarizeAnalyticsRows([
    row({ event_code: "OBAV6L" }),
    row({ event_code: "OBAV6L", movie_title: "OBAV6L", movie_variant: "OBAV6L", sold: 300, collection_paise: 3_000_000 })
  ], {
    movieTitle: "Irumudi",
    startDate: "2026-08-21",
    endDate: "2026-08-21",
    now: new Date("2026-08-22T00:00:00.000Z")
  });

  assert.equal(summary.total.screenedShows, 2);
  assert.equal(summary.total.collectionPaise, 7_015_300);
});

test("builds two price tiers while combining same-price theatre classes", () => {
  const profiles = buildCapacityProfiles([
    {
      venue_code: "RTDM",
      captured_at: "2026-08-30T16:49:10.553Z",
      categories_json: JSON.stringify([
        { name: "BALCONY", listPricePaise: 17000, capacity: 132 },
        { name: "RESERVED", listPricePaise: 17000, capacity: 213 },
        { name: "FIRST CLASS", listPricePaise: 17000, capacity: 112 },
        { name: "SECOND CLASS", listPricePaise: 10000, capacity: 180 }
      ])
    }
  ]);

  assert.equal(profiles[0].capacity, 637);
  assert.deepEqual(profiles[0].tiers.map((tier) => [tier.listPricePaise, tier.capacity]), [
    [17000, 457],
    [10000, 180]
  ]);
});
