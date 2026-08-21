import test from "node:test";
import assert from "node:assert/strict";
import { groupShowsByMovie, movieGroupKey, sortMovieGroups } from "./movieGroups.js";

function show(overrides = {}) {
  return {
    id: "show-1",
    movieTitle: "Irumudi",
    language: "Telugu",
    format: "2D",
    venueShortName: "Sri Krishna",
    showTime: "11:00 AM",
    startAt: "2026-08-21T11:00:00+05:30",
    status: "completed",
    snapshot: { sold: 100, capacity: 200, collectionPaise: 1_000_000 },
    ...overrides
  };
}

test("movie keys normalize punctuation and case while retaining language and format", () => {
  assert.equal(
    movieGroupKey(show({ movieTitle: "  IRUMUDI!! " })),
    movieGroupKey(show({ movieTitle: "Irumudi" }))
  );
  assert.notEqual(
    movieGroupKey(show({ language: "Hindi" })),
    movieGroupKey(show({ language: "Telugu" }))
  );
});

test("movie groups total captured snapshots and exclude missed or pending shows", () => {
  const groups = groupShowsByMovie([
    show(),
    show({ id: "show-2", venueShortName: "Ravi", snapshot: { sold: 50, capacity: 100, collectionPaise: 500_000 } }),
    show({ id: "show-3", status: "missed", snapshot: null }),
    show({ id: "show-4", status: "scheduled", snapshot: null })
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(
    {
      captured: groups[0].capturedShows,
      finalized: groups[0].finalizedShows,
      missed: groups[0].missedShows,
      pending: groups[0].pendingShows,
      tickets: groups[0].ticketsSold,
      collection: groups[0].collectionPaise,
      occupancy: groups[0].occupancyPercent
    },
    { captured: 2, finalized: 2, missed: 1, pending: 1, tickets: 150, collection: 1_500_000, occupancy: 50 }
  );
});

test("movie groups can be sorted by gross, tickets, earliest show, or name", () => {
  const groups = groupShowsByMovie([
    show({ movieTitle: "Bravo", snapshot: { sold: 40, capacity: 100, collectionPaise: 800_000 } }),
    show({ movieTitle: "Alpha", startAt: "2026-08-21T08:00:00+05:30", snapshot: { sold: 80, capacity: 100, collectionPaise: 600_000 } })
  ]);

  assert.equal(sortMovieGroups(groups, "gross")[0].movieTitle, "Bravo");
  assert.equal(sortMovieGroups(groups, "tickets")[0].movieTitle, "Alpha");
  assert.equal(sortMovieGroups(groups, "earliest")[0].movieTitle, "Alpha");
  assert.equal(sortMovieGroups(groups, "name")[0].movieTitle, "Alpha");
});
