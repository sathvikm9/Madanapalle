import test from "node:test";
import assert from "node:assert/strict";
import { formatAnalyticsAnswer, formatComparisonAnswer, parseAnalyticsQuestion, READ_ONLY_REPLY, SHORTCUTS_REPLY } from "./analyticsQuery.js";

const catalog = {
  firstLiveDate: "2026-08-21",
  movies: [
    { title: "Irumudi", firstTrackedDate: "2026-08-21" },
    { title: "Toxic: A Fairy Tale for Grown-ups", firstTrackedDate: "2026-08-26" },
    { title: "Vishwanath and Sons", firstTrackedDate: "2026-08-21" }
  ]
};
const now = new Date("2026-08-30T10:00:00.000Z");

test("parses theatre-wise first-week questions", () => {
  const result = parseAnalyticsQuestion("Give theatre wise data for Irumudi 1st week", catalog, now);
  assert.deepEqual(result.request, {
    movieTitle: "Irumudi",
    venueCode: "ALL",
    theatreName: "All theatres",
    theatreWise: true,
    metric: "report",
    key: "first_week",
    label: "First week",
    startDate: "2026-08-21",
    endDate: "2026-08-27"
  });
});

test("parses a theatre-specific gross and a movie alias", () => {
  const result = parseAnalyticsQuestion("What is Sai Chitra Irumudi first week gross?", catalog, now);
  assert.equal(result.request.venueCode, "SCM");
  assert.equal(result.request.metric, "gross");
  assert.equal(result.request.endDate, "2026-08-27");

  const toxic = parseAnalyticsQuestion("What is Toxic Day1 gross?", catalog, now);
  assert.equal(toxic.request.movieTitle, "Toxic: A Fairy Tale for Grown-ups");
  assert.equal(toxic.request.startDate, "2026-08-26");
  assert.equal(toxic.request.endDate, "2026-08-26");
});

test("understands compact movie, theatre, period and metric shortcuts", () => {
  const week = parseAnalyticsQuestion("iru 1w g", catalog, now).request;
  assert.equal(week.movieTitle, "Irumudi");
  assert.equal(week.key, "first_week");
  assert.equal(week.metric, "gross");

  const theatre = parseAnalyticsQuestion("vis sk hf", catalog, now).request;
  assert.equal(theatre.movieTitle, "Vishwanath and Sons");
  assert.equal(theatre.venueCode, "SKMD");
  assert.equal(theatre.metric, "housefull");

  const day = parseAnalyticsQuestion("tox d1 tix", catalog, now).request;
  assert.equal(day.movieTitle, "Toxic: A Fairy Tale for Grown-ups");
  assert.equal(day.key, "movie_day");
  assert.equal(day.metric, "tickets");
});

test("understands date-only and conversational shortcuts", () => {
  const daily = parseAnalyticsQuestion("28 rpt", catalog, now).request;
  assert.equal(daily.movieTitle, "ALL");
  assert.equal(daily.startDate, "2026-08-28");
  assert.equal(daily.metric, "report");

  const first = parseAnalyticsQuestion("iru d9 hf", catalog, now).request;
  const gross = parseAnalyticsQuestion("g", catalog, now, first).request;
  assert.equal(gross.movieTitle, "Irumudi");
  assert.equal(gross.startDate, "2026-08-29");
  assert.equal(gross.metric, "gross");

  const ravi = parseAnalyticsQuestion("rv", catalog, now, gross).request;
  assert.equal(ravi.venueCode, "RTDM");
  assert.equal(ravi.metric, "gross");

  const dailyAfterMovie = parseAnalyticsQuestion("28 rpt", catalog, now, ravi).request;
  assert.equal(dailyAfterMovie.movieTitle, "ALL");
  assert.equal(dailyAfterMovie.metric, "report");
});

test("returns an embedded shortcut guide", () => {
  assert.equal(parseAnalyticsQuestion("help", catalog, now).reply, SHORTCUTS_REPLY);
  assert.match(SHORTCUTS_REPLY, /rv 170 100/);
});

test("tolerates small movie, theatre and title-joiner mistakes", () => {
  const movieTypo = parseAnalyticsQuestion("Irumdi g", catalog, now).request;
  assert.equal(movieTypo.movieTitle, "Irumudi");

  const theatreTypo = parseAnalyticsQuestion("Irumdi Sai Citra g", catalog, now).request;
  assert.equal(theatreTypo.venueCode, "SCM");

  const missingJoiner = parseAnalyticsQuestion("Vishwanath sons g", catalog, now).request;
  assert.equal(missingJoiner.movieTitle, "Vishwanath and Sons");
});

test("asks for clarification when a typo is genuinely ambiguous", () => {
  const ambiguousCatalog = {
    ...catalog,
    movies: [
      { title: "Maya", firstTrackedDate: "2026-08-21" },
      { title: "Mala", firstTrackedDate: "2026-08-21" }
    ]
  };
  const result = parseAnalyticsQuestion("Mapa gross", ambiguousCatalog, now);
  assert.match(result.reply, /not certain/i);
  assert.match(result.reply, /Maya or Mala|Mala or Maya/);
});

test("asks for clarification when a shortened title belongs to multiple movies", () => {
  const paradiseCatalog = {
    ...catalog,
    movies: [
      { title: "The Paradise", firstTrackedDate: "2026-08-21" },
      { title: "Paradise Lost", firstTrackedDate: "2026-08-21" }
    ]
  };
  const result = parseAnalyticsQuestion("Paradise first week gross", paradiseCatalog, now);
  assert.match(result.reply, /not certain/i);
  assert.match(result.reply, /The Paradise/);
  assert.match(result.reply, /Paradise Lost/);

  const exact = parseAnalyticsQuestion("The Paradise first week gross", paradiseCatalog, now);
  assert.equal(exact.request.movieTitle, "The Paradise");
});

test("parses movie and movie-day comparisons", () => {
  const movies = parseAnalyticsQuestion("Compare Irumudi and Toxic first weekend", catalog, now).request;
  assert.equal(movies.mode, "comparison");
  assert.equal(movies.comparisonType, "movies");
  assert.deepEqual(movies.entries.map((entry) => entry.movieTitle), ["Irumudi", "Toxic: A Fairy Tale for Grown-ups"]);
  assert.deepEqual(movies.entries.map((entry) => [entry.startDate, entry.endDate]), [
    ["2026-08-21", "2026-08-23"],
    ["2026-08-28", "2026-08-30"]
  ]);

  const shortcut = parseAnalyticsQuestion("iru vs tox 1we", catalog, now).request;
  assert.deepEqual(shortcut.entries.map((entry) => entry.movieTitle), [
    "Irumudi",
    "Toxic: A Fairy Tale for Grown-ups"
  ]);

  const context = parseAnalyticsQuestion("Irumudi g", catalog, now).request;
  const days = parseAnalyticsQuestion("Compare Day 1 and Day 2", catalog, now, context).request;
  assert.equal(days.comparisonType, "periods");
  assert.deepEqual(days.entries.map((entry) => entry.label), ["Day 1", "Day 2"]);
});

test("parses highest-theatre, day-wise and highest-housefull-day analysis", () => {
  assert.equal(
    parseAnalyticsQuestion("Which theatre has the highest Irumudi gross?", catalog, now).request.analysisType,
    "highest_theatre"
  );
  assert.equal(
    parseAnalyticsQuestion("Give day-wise Irumudi gross", catalog, now).request.analysisType,
    "day_wise"
  );
  assert.equal(
    parseAnalyticsQuestion("Which day had the most Irumudi housefull shows?", catalog, now).request.analysisType,
    "highest_housefull_day"
  );
});

test("uses inclusive movie-day ranges", () => {
  const result = parseAnalyticsQuestion("What is Irumudi 10 days gross?", catalog, now);
  assert.equal(result.request.startDate, "2026-08-21");
  assert.equal(result.request.endDate, "2026-08-30");
});

test("understands explicit calendar dates in either order", () => {
  const monthFirst = parseAnalyticsQuestion("What's Vishwanath and Sons Aug 30th gross?", catalog, now);
  assert.equal(monthFirst.request.startDate, "2026-08-30");
  assert.equal(monthFirst.request.endDate, "2026-08-30");
  assert.equal(monthFirst.request.metric, "gross");

  const dayFirst = parseAnalyticsQuestion("Irumudi gross on 27th August", catalog, now);
  assert.equal(dayFirst.request.startDate, "2026-08-27");
  assert.equal(dayFirst.request.endDate, "2026-08-27");
});

test("uses a date-only gross question as an all-movies daily total", () => {
  const result = parseAnalyticsQuestion("Aug 28th gross?", catalog, now);
  assert.equal(result.request.movieTitle, "ALL");
  assert.equal(result.request.startDate, "2026-08-28");
  assert.equal(result.request.endDate, "2026-08-28");
  assert.equal(result.request.metric, "gross");
  assert.equal(result.request.venueCode, "ALL");
});

test("uses a date-only report as an all-theatre daily breakdown", () => {
  const result = parseAnalyticsQuestion("Aug 28th report?", catalog, now);
  assert.equal(result.request.movieTitle, "ALL");
  assert.equal(result.request.metric, "report");
  assert.equal(result.request.theatreWise, true);
  assert.equal(result.request.startDate, "2026-08-28");
});

test("switches from a daily gross follow-up to an explicit full report", () => {
  const gross = parseAnalyticsQuestion("Aug 28th gross?", catalog, now).request;
  const report = parseAnalyticsQuestion("Aug 28th report?", catalog, now, gross).request;
  assert.equal(report.metric, "report");
  assert.equal(report.theatreWise, true);
});

test("understands calendar ranges, today and yesterday", () => {
  const range = parseAnalyticsQuestion("Irumudi gross Aug 25 to Aug 27", catalog, now);
  assert.equal(range.request.startDate, "2026-08-25");
  assert.equal(range.request.endDate, "2026-08-27");

  const todayResult = parseAnalyticsQuestion("Irumudi gross today", catalog, now);
  assert.equal(todayResult.request.startDate, "2026-08-30");
  const yesterdayResult = parseAnalyticsQuestion("Irumudi gross yesterday", catalog, now);
  assert.equal(yesterdayResult.request.startDate, "2026-08-29");
});

test("understands first weekend and individual movie days", () => {
  const weekend = parseAnalyticsQuestion("What's Irumudi 1st weekend gross?", catalog, now);
  assert.equal(weekend.request.key, "first_weekend");
  assert.equal(weekend.request.startDate, "2026-08-21");
  assert.equal(weekend.request.endDate, "2026-08-23");

  const dayThree = parseAnalyticsQuestion("Irumudi Day 3 gross", catalog, now);
  assert.equal(dayThree.request.startDate, "2026-08-23");
  assert.equal(dayThree.request.endDate, "2026-08-23");
});

test("refuses all requests to mutate tracked data", () => {
  const result = parseAnalyticsQuestion("This show is wrong, update this gross", catalog, now);
  assert.equal(result.reply, READ_ONLY_REPLY);
});

test("inherits movie and Day 9 when a follow-up asks only for gross", () => {
  const first = parseAnalyticsQuestion("Irumudi 9th day how many shows full?", catalog, now).request;
  assert.equal(first.movieTitle, "Irumudi");
  assert.equal(first.metric, "housefull");
  assert.equal(first.startDate, "2026-08-29");

  const followUp = parseAnalyticsQuestion("and gross?", catalog, now, first).request;
  assert.equal(followUp.movieTitle, "Irumudi");
  assert.equal(followUp.metric, "gross");
  assert.equal(followUp.startDate, "2026-08-29");
  assert.equal(followUp.endDate, "2026-08-29");
});

test("inherits the previous subject when changing only theatre or period", () => {
  const first = parseAnalyticsQuestion("Irumudi first weekend gross", catalog, now).request;
  const ravi = parseAnalyticsQuestion("what about Ravi?", catalog, now, first).request;
  assert.equal(ravi.movieTitle, "Irumudi");
  assert.equal(ravi.venueCode, "RTDM");
  assert.equal(ravi.metric, "gross");
  assert.equal(ravi.key, "first_weekend");

  const dayThree = parseAnalyticsQuestion("and Day 3?", catalog, now, ravi).request;
  assert.equal(dayThree.movieTitle, "Irumudi");
  assert.equal(dayThree.venueCode, "RTDM");
  assert.equal(dayThree.metric, "gross");
  assert.equal(dayThree.startDate, "2026-08-23");
});

test("recalculates a relative period when the follow-up changes movie", () => {
  const first = parseAnalyticsQuestion("Irumudi first weekend gross", catalog, now).request;
  const toxic = parseAnalyticsQuestion("same for Toxic", catalog, now, first).request;
  assert.equal(toxic.movieTitle, "Toxic: A Fairy Tale for Grown-ups");
  assert.equal(toxic.startDate, "2026-08-28");
  assert.equal(toxic.endDate, "2026-08-30");
  assert.equal(toxic.metric, "gross");
});

test("a newly stated movie resets an inherited period unless the user says same", () => {
  const weekend = parseAnalyticsQuestion("Irumudi first weekend gross", catalog, now).request;
  const fresh = parseAnalyticsQuestion("Which theatre has the highest Irumudi gross?", catalog, now, weekend).request;
  assert.equal(fresh.key, "till_now");
  assert.equal(fresh.endDate, "2026-08-30");
});

test("formats theatre-wise answers with coverage", () => {
  const parsed = parseAnalyticsQuestion("Give theatre wise data for Irumudi till now", catalog, now).request;
  const answer = formatAnalyticsAnswer(parsed, {
    movieTitle: "Irumudi",
    startDate: "2026-08-21",
    endDate: "2026-08-30",
    total: { screenedShows: 5, capturedShows: 4, housefullShows: 3, ticketsSold: 2000, collectionPaise: 19_500_000 },
    venues: [
      { name: "Sai Chitra", screenedShows: 3, capturedShows: 3, housefullShows: 3, ticketsSold: 1200, collectionPaise: 12_000_000 },
      { name: "ASR", screenedShows: 2, capturedShows: 1, housefullShows: 0, ticketsSold: 800, collectionPaise: 7_500_000 }
    ]
  });
  assert.match(answer, /Total gross: ₹1,95,000/);
  assert.match(answer, /Shows: 3\/5 full/);
  assert.match(answer, /Data captured: 4\/5 shows/);
  assert.match(answer, /Sai Chitra\nGross: ₹1,20,000/);
});

test("formats an all-movies daily report without asking for a movie", () => {
  const request = parseAnalyticsQuestion("Aug 28th report?", catalog, now).request;
  const answer = formatAnalyticsAnswer(request, {
    movieTitle: "All movies",
    startDate: "2026-08-28",
    endDate: "2026-08-28",
    total: { screenedShows: 8, capturedShows: 8, housefullShows: 5, ticketsSold: 3200, collectionPaise: 30_000_000 },
    venues: [
      { name: "Sai Chitra", screenedShows: 4, capturedShows: 4, housefullShows: 4, ticketsSold: 1600, collectionPaise: 15_000_000 }
    ]
  });
  assert.match(answer, /^All theatres — Selected date/);
  assert.match(answer, /Total gross: ₹3,00,000/);
  assert.match(answer, /Tickets: 3,200/);
  assert.match(answer, /Sai Chitra\nGross: ₹1,50,000/);
});

test("formats comparisons and advanced ranking answers", () => {
  const entries = parseAnalyticsQuestion("Compare Irumudi and Toxic first weekend", catalog, now).request;
  const comparison = formatComparisonAnswer(entries, [
    {
      movieTitle: "Irumudi", startDate: "2026-08-21", endDate: "2026-08-23",
      total: { screenedShows: 10, capturedShows: 10, housefullShows: 8, ticketsSold: 5000, collectionPaise: 50_000_000 }
    },
    {
      movieTitle: "Toxic: A Fairy Tale for Grown-ups", startDate: "2026-08-28", endDate: "2026-08-30",
      total: { screenedShows: 8, capturedShows: 8, housefullShows: 4, ticketsSold: 3000, collectionPaise: 30_000_000 }
    }
  ]);
  assert.match(comparison, /Irumudi vs Toxic/);
  assert.match(comparison, /Irumudi leads by ₹2,00,000/);

  const highestRequest = parseAnalyticsQuestion("Which theatre has the highest Irumudi gross?", catalog, now).request;
  const highest = formatAnalyticsAnswer(highestRequest, {
    movieTitle: "Irumudi", startDate: "2026-08-21", endDate: "2026-08-30",
    total: { screenedShows: 8, capturedShows: 8, housefullShows: 4, ticketsSold: 3000, collectionPaise: 30_000_000 },
    venues: [
      { name: "Ravi", screenedShows: 4, capturedShows: 4, collectionPaise: 18_000_000 },
      { name: "ASR", screenedShows: 4, capturedShows: 4, collectionPaise: 12_000_000 }
    ],
    days: []
  });
  assert.match(highest, /Ravi is highest at ₹1,80,000/);
});
