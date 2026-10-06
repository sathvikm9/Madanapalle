import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReportModel,
  completedReportEndDate,
  defaultReportStartDate,
  movieReportRange,
  movieReportStartDate,
  reportCsv,
  reportSummaryQuery,
  reportText,
  sortMoviesByGross,
  trackedReportDays
} from "./reports.js";

const summary = {
  total: { screenedShows: 3, capturedShows: 2, housefullShows: 1, ticketsSold: 500, capacity: 900, collectionPaise: 5_000_000 },
  venues: [
    {
      code: "RTDM", name: "Ravi", screenedShows: 2, capturedShows: 2, housefullShows: 1,
      ticketsSold: 400, capacity: 600, collectionPaise: 4_000_000,
      movies: [
        { title: "The Paradise", screenedShows: 1, capturedShows: 1, housefullShows: 1, ticketsSold: 250, capacity: 300, collectionPaise: 2_500_000 },
        { title: "Irumudi", screenedShows: 1, capturedShows: 1, housefullShows: 0, ticketsSold: 150, capacity: 300, collectionPaise: 1_500_000 }
      ]
    },
    {
      code: "ASRM", name: "ASR", screenedShows: 1, capturedShows: 0, housefullShows: 0,
      ticketsSold: 100, capacity: 300, collectionPaise: 1_000_000,
      movies: [{ title: "Irumudi", screenedShows: 1, capturedShows: 0, housefullShows: 0, ticketsSold: 100, capacity: 300, collectionPaise: 1_000_000 }]
    }
  ],
  days: [
    { date: "2026-10-01", screenedShows: 2, capturedShows: 1, housefullShows: 0, ticketsSold: 200, capacity: 600, collectionPaise: 2_000_000 },
    { date: "2026-10-02", screenedShows: 1, capturedShows: 1, housefullShows: 1, ticketsSold: 300, capacity: 300, collectionPaise: 3_000_000 }
  ]
};

test("uses a bounded rolling 30-day report range", () => {
  assert.equal(defaultReportStartDate("2026-10-05", "2026-08-21"), "2026-09-06");
  assert.equal(defaultReportStartDate("2026-08-25", "2026-08-21"), "2026-08-21");
});

test("starts a movie report at its premiere or day-one date", () => {
  assert.equal(movieReportStartDate({ premiereDate: "2026-09-23", dayOneDate: "2026-09-24", firstTrackedDate: "2026-09-23" }, "2026-08-21"), "2026-09-23");
  assert.equal(movieReportStartDate({ dayOneDate: "2026-09-25", firstTrackedDate: "2026-09-25" }, "2026-08-21"), "2026-09-25");
  assert.equal(movieReportStartDate({}, "2026-08-21"), "2026-08-21");
});

test("builds opening, first-week and full-run movie ranges", () => {
  const premiereMovie = {
    premiereDate: "2026-09-23",
    dayOneDate: "2026-09-24",
    firstTrackedDate: "2026-09-23",
    lastTrackedDate: "2026-10-05"
  };
  assert.deepEqual(movieReportRange(premiereMovie, "opening", "2026-10-06"), {
    startDate: "2026-09-23", endDate: "2026-09-24", hasPremiere: true,
    fullRunStartDate: "2026-09-23", fullRunEndDate: "2026-10-05"
  });
  assert.equal(movieReportRange(premiereMovie, "week1", "2026-10-06").endDate, "2026-09-30");
  assert.equal(movieReportRange(premiereMovie, "full", "2026-10-06").endDate, "2026-10-05");

  const regularMovie = { firstTrackedDate: "2026-09-01", dayOneDate: "2026-09-01", lastTrackedDate: "2026-09-10" };
  assert.deepEqual(movieReportRange(regularMovie, "opening", "2026-10-06"), {
    startDate: "2026-09-01", endDate: "2026-09-01", hasPremiere: false,
    fullRunStartDate: "2026-09-01", fullRunEndDate: "2026-09-10"
  });
});

test("movie reports request only fully completed days", () => {
  const movieQuery = reportSummaryQuery({
    movieTitle: "The Paradise",
    venueCode: "ALL",
    startDate: "2026-09-11",
    endDate: "2026-10-01",
    completeDaysOnly: true
  });
  const theatreQuery = reportSummaryQuery({
    movieTitle: "ALL",
    venueCode: "ALL",
    startDate: "2026-09-11",
    endDate: "2026-10-01"
  });

  assert.equal(movieQuery.get("completeDaysOnly"), "1");
  assert.equal(theatreQuery.has("completeDaysOnly"), false);
  assert.equal(completedReportEndDate([{ endDate: "2026-09-30" }], "2026-10-01"), "2026-09-30");
});

test("counts unique screened dates across theatre summaries", () => {
  assert.equal(trackedReportDays([summary, summary]), 2);
  assert.equal(trackedReportDays([{ days: [{ date: "2026-10-03", screenedShows: 0 }] }]), 0);
});

test("orders movie choices by full-run gross with tickets as the tie-breaker", () => {
  const movies = sortMoviesByGross([
    { title: "Lower", collectionPaise: 2_000_000, ticketsSold: 400 },
    { title: "Highest", collectionPaise: 5_000_000, ticketsSold: 300 },
    { title: "Same gross, more tickets", collectionPaise: 2_000_000, ticketsSold: 500 }
  ]);

  assert.deepEqual(movies.map((movie) => movie.title), [
    "Highest",
    "Same gross, more tickets",
    "Lower"
  ]);
});

test("groups reports by theatre and exposes movie details", () => {
  const model = buildReportModel([summary], "theatre", "tickets");
  assert.deepEqual(model.rows.map((row) => row.label), ["Ravi", "ASR"]);
  assert.deepEqual(model.rows[0].details.map((row) => row.label), ["The Paradise", "Irumudi"]);
  assert.equal(model.totals.ticketsSold, 500);
});

test("combines the same movie across theatres", () => {
  const model = buildReportModel([summary], "movie", "gross");
  assert.equal(model.rows[0].label, "Irumudi");
  assert.equal(model.rows[0].ticketsSold, 250);
  assert.deepEqual(model.rows[0].details.map((row) => row.label), ["Ravi", "ASR"]);
});

test("groups and sorts a report by date", () => {
  const model = buildReportModel([summary], "date", "gross");
  assert.deepEqual(model.rows.map((row) => row.label), ["2026-10-02", "2026-10-01"]);
});

test("formats copy and CSV exports", () => {
  const model = buildReportModel([summary], "theatre", "tickets");
  assert.match(reportText({ startDate: "2026-10-01", endDate: "2026-10-02", model }), /Ravi — 2 shows · 400 tickets/);
  assert.match(reportText({ startDate: "2026-10-01", endDate: "2026-10-02", title: "Irumudi collection report", model }), /^Irumudi collection report/);
  assert.match(reportCsv(model), /"Ravi","2","2","400","40000"/);
});
