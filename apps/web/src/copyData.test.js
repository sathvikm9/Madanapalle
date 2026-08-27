import test from "node:test";
import assert from "node:assert/strict";
import { buildMoviesCopyText, buildShowsCopyText } from "./copyData.js";

function show(overrides = {}) {
  return {
    venueCode: "SKMD",
    venueShortName: "Sri Krishna",
    showTime: "11:00 AM",
    movieTitle: "Irumudi",
    status: "completed",
    snapshot: { collectionPaise: 445800 },
    ...overrides
  };
}

test("copies a single theatre and repeats a single movie only once", () => {
  const text = buildShowsCopyText({
    date: "2026-08-27",
    theatre: "Sri Krishna",
    shows: [show(), show({ showTime: "02:00 PM", snapshot: { collectionPaise: 5518000 } })]
  });

  assert.equal(text, [
    "27th August - Sri Krishna",
    "Irumudi",
    "11:00AM - *4,458/-*",
    "02:00PM - *55,180/-*"
  ].join("\n"));
});

test("includes each movie title when a theatre screens multiple movies", () => {
  const text = buildShowsCopyText({
    date: "2026-08-21",
    theatre: "Sri Krishna",
    shows: [show(), show({ showTime: "02:00 PM", movieTitle: "Vishwanath and Sons" })]
  });

  assert.equal(text, [
    "21st August - Sri Krishna",
    "11:00AM - Irumudi - *4,458/-*",
    "02:00PM - Vishwanath and Sons - *4,458/-*"
  ].join("\n"));
});

test("groups all-theatre show data by theatre", () => {
  const text = buildShowsCopyText({
    date: "2026-08-22",
    theatre: "All theatres",
    allTheatres: true,
    shows: [show(), show({ venueCode: "RTDM", venueShortName: "Ravi", showTime: "07:30 AM" })]
  });

  assert.match(text, /^22nd August - All theatres/);
  assert.match(text, /Sri Krishna\nIrumudi\n11:00AM/);
  assert.match(text, /Ravi\nIrumudi\n07:30AM/);
});

test("copies movie totals with singular and plural show labels", () => {
  const text = buildMoviesCopyText({
    date: "2026-08-27",
    theatre: "Sri Krishna",
    movies: [
      { movieTitle: "Irumudi", shows: [{}], collectionPaise: 3356900 },
      { movieTitle: "Vishwanath and Sons", shows: [{}, {}, {}], collectionPaise: 2161100 }
    ]
  });

  assert.equal(text, [
    "27th August - Sri Krishna",
    "Irumudi - 1 Show - *33,569/-*",
    "Vishwanath and Sons - 3 Shows - *21,611/-*"
  ].join("\n"));
});
