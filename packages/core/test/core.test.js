import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateCollection,
  captureAtFromStart,
  captureAtFromCutoff,
  classifyScheduleChanges,
  extractAssignedJson,
  movieReleaseSchedule,
  movieRunIsAvailable,
  movieRunForDate,
  parseVenueShowsFromHtml,
  reconcileHistoricalScheduleChanges
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

test("schedules an early backup from the show start", () => {
  assert.equal(captureAtFromStart("2026-08-20T05:30:00.000Z", 10), "2026-08-20T05:40:00.000Z");
});

test("treats a movie first tracked before 6 PM IST as Day 1", () => {
  const release = movieReleaseSchedule("2026-08-21T05:30:00.000Z");
  assert.deepEqual(release, {
    firstShowAt: "2026-08-21T05:30:00.000Z",
    firstTrackedDate: "2026-08-21",
    firstShowHour: 11,
    officialReleaseDate: null,
    releaseDateSource: "first-show-fallback",
    isReRelease: false,
    hasPremiere: false,
    premiereDate: null,
    dayOneDate: "2026-08-21"
  });
  assert.equal(movieRunForDate(release.firstShowAt, "2026-08-21").dayLabel, "Day 1");
  assert.equal(movieRunForDate(release.firstShowAt, "2026-08-21").weekLabel, null);
  assert.equal(movieRunForDate(release.firstShowAt, "2026-08-26").weekLabel, null);
  assert.equal(movieRunForDate(release.firstShowAt, "2026-08-27").weekLabel, "1st Week");
  assert.equal(movieRunForDate(release.firstShowAt, "2026-08-28").weekLabel, "2nd Week");
});

test("uses BookMyShow release date instead of treating a release-day evening show as premieres", () => {
  const firstShowAt = "2026-09-25T12:30:00.000Z"; // 6 PM in India.
  const run = movieRunForDate(firstShowAt, "2026-09-25", { releaseDate: "2026-09-25" });
  assert.equal(run.dayLabel, "Day 1");
  assert.equal(run.weekLabel, null);
  assert.equal(run.hasPremiere, false);
  assert.equal(run.releaseDateSource, "bookmyshow");
});

test("uses the pre-release show date as premieres and the official date as Day 1", () => {
  const firstShowAt = "2026-09-23T16:15:00.000Z";
  assert.equal(
    movieRunForDate(firstShowAt, "2026-09-23", { releaseDate: "2026-09-24" }).dayLabel,
    "Premieres"
  );
  assert.equal(
    movieRunForDate(firstShowAt, "2026-09-24", { releaseDate: "2026-09-24" }).dayLabel,
    "Day 1"
  );
});

test("labels a newly tracked film with an older BookMyShow release date as a re-release", () => {
  const firstShowAt = "2026-09-27T05:30:00.000Z";
  const run = movieRunForDate(firstShowAt, "2026-09-27", { releaseDate: "2024-09-27" });
  assert.equal(run.dayLabel, "Re-Release");
  assert.equal(run.weekLabel, null);
  assert.equal(run.isReRelease, true);
});

test("treats an evening first show as premieres and begins Day 1 the next date", () => {
  const firstShowAt = "2026-09-23T16:15:00.000Z"; // 9:45 PM in India.
  const premiere = movieRunForDate(firstShowAt, "2026-09-23");
  const dayOne = movieRunForDate(firstShowAt, "2026-09-24");
  const daySeven = movieRunForDate(firstShowAt, "2026-09-30");
  const dayEight = movieRunForDate(firstShowAt, "2026-10-01");

  assert.equal(premiere.dayLabel, "Premieres");
  assert.equal(premiere.weekLabel, null);
  assert.equal(dayOne.dayLabel, "Day 1");
  assert.equal(dayOne.weekLabel, null);
  assert.equal(daySeven.weekLabel, "1st Week");
  assert.equal(dayEight.dayLabel, "Day 8");
  assert.equal(dayEight.weekLabel, "2nd Week");
});

test("formats later movie weeks with stable ordinal labels", () => {
  const firstShowAt = "2026-08-21T05:30:00.000Z";
  assert.equal(movieRunForDate(firstShowAt, "2026-09-19").dayLabel, "Day 30");
  assert.equal(movieRunForDate(firstShowAt, "2026-09-19").weekLabel, "5th Week");
});

test("hides movie-run labels for legacy titles whose release predates tracking", () => {
  assert.equal(movieRunIsAvailable("Vishwanath and Sons"), false);
  assert.equal(movieRunIsAvailable("Awarapan 2"), false);
  assert.equal(movieRunIsAvailable("HUSHAR PITTALU"), false);
  assert.equal(movieRunIsAvailable("The Paradise"), true);
  assert.equal(movieRunIsAvailable("Irumudi"), true);
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
    captureStartAfterShowMinutes: 10
  }, "20260820");
  assert.equal(shows[0].captureAt, "2026-08-20T05:40:00.000Z");
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

for (const [previousTime, nextTime] of [
  ["11:00:00", "11:45:00"],
  ["14:00:00", "14:15:00"],
  ["18:00:00", "18:30:00"],
  ["21:00:00", "21:45:00"]
]) {
  test(`detects a shifted replacement from ${previousTime} to ${nextTime}`, () => {
    const changes = classifyScheduleChanges(
      [{
        slotKey: `SKMD:20260820:${previousTime.replaceAll(":", "").slice(0, 4)}`,
        naturalKey: "old",
        startAt: `2026-08-20T${previousTime}+05:30`,
        isCurrent: true
      }],
      [{
        slotKey: `SKMD:20260820:${nextTime.replaceAll(":", "").slice(0, 4)}`,
        naturalKey: "new",
        startAt: `2026-08-20T${nextTime}+05:30`
      }]
    );

    assert.equal(changes.replaced.length, 1);
    assert.equal(changes.added.length, 0);
    assert.equal(changes.removed.length, 0);
  });
}

test("does not merge independent shows outside the one-hour audit window", () => {
  const changes = classifyScheduleChanges(
    [{
      slotKey: "SKMD:20260820:1100",
      naturalKey: "old",
      startAt: "2026-08-20T11:00:00+05:30",
      isCurrent: true
    }],
    [{
      slotKey: "SKMD:20260820:1215",
      naturalKey: "new",
      startAt: "2026-08-20T12:15:00+05:30"
    }]
  );

  assert.equal(changes.replaced.length, 0);
  assert.equal(changes.added.length, 1);
  assert.equal(changes.removed.length, 1);
});

test("reconstructs a historical shifted replacement from separate removed and added events", () => {
  const changes = reconcileHistoricalScheduleChanges([
    {
      id: "607",
      venueCode: "SKMD",
      showDate: "2026-09-23",
      type: "removed",
      previousShowId: "43004",
      previousShowTime: "09:00 PM",
      previousMovie: "Mandaadi",
      previousStartAt: "2026-09-23T21:00:00+05:30",
      observedAt: "2026-09-23T08:10:45.175Z"
    },
    {
      id: "608",
      venueCode: "SKMD",
      showDate: "2026-09-23",
      type: "added",
      nextShowId: "43754",
      nextShowTime: "10:00 PM",
      nextMovie: "The Paradise",
      nextStartAt: "2026-09-23T22:00:00+05:30",
      observedAt: "2026-09-23T08:25:44.710Z"
    }
  ]);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, "replaced");
  assert.equal(changes[0].previousShowTime, "09:00 PM");
  assert.equal(changes[0].nextShowTime, "10:00 PM");
  assert.equal(changes[0].nextMovie, "The Paradise");
  assert.equal(changes[0].reconstructed, true);
});

test("does not use an initial added event that predates a later removal", () => {
  const changes = reconcileHistoricalScheduleChanges([
    {
      id: "1",
      venueCode: "SKMD",
      showDate: "2026-09-23",
      type: "added",
      nextShowId: "old",
      nextShowTime: "09:00 PM",
      nextMovie: "Mandaadi",
      nextStartAt: "2026-09-23T21:00:00+05:30",
      observedAt: "2026-09-22T18:30:00.000Z"
    },
    {
      id: "2",
      venueCode: "SKMD",
      showDate: "2026-09-23",
      type: "removed",
      previousShowId: "old",
      previousShowTime: "09:00 PM",
      previousMovie: "Mandaadi",
      previousStartAt: "2026-09-23T21:00:00+05:30",
      observedAt: "2026-09-23T08:10:00.000Z"
    }
  ]);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, "removed");
  assert.equal(changes[0].nextMovie, undefined);
});
