import assert from "node:assert/strict";
import test from "node:test";

await import("./ticketnew.js");
const {
  capture,
  captureLive,
  discover,
  findLiveSeatLayoutUrl,
  findSessionControl,
  isLiveSeatLayout
} = globalThis.SKCTTicketNew;

const state = {
  props: { pageProps: { data: { serverState: { cinemaSessions: {
    "49032026-08-21": {
      meta: { cinema: { id: 4903 }, movies: [{ id: "MOV1", name: "Test Movie" }] },
      pageData: {
        sessions: [{
          sid: "screen__session",
          mid: "MOV1",
          showTime: "2026-08-21T05:30",
          closeTime: "2026-08-21T05:45",
          lang: "Telugu",
          scrnFmt: "2D",
          audi: "SAI CHITRA 4K",
          areas: [
            { code: "RES", label: "RESERVED CL", sTotal: 317, sAvail: 17, price: 105 },
            { code: "FST", label: "FIRST CL", sTotal: 107, sAvail: 47, price: 84 }
          ]
        }],
        arrangedSessions: [{
          entityCode: 123,
          entityName: "Test Movie",
          data: { name: "Test Movie", lang: "Telugu" },
          sessions: [{ sid: "screen__session" }]
        }]
      }
    }
  } } } } }
};

const venue = {
  venueCode: "SCM",
  cinemaId: 4903,
  captureStartAfterShowMinutes: 10
};

test("discovers Sai Chitra TicketNew sessions in India time", () => {
  const result = discover(
    state,
    venue,
    "20260821",
    "https://ticketnew.com/movies/madanapalle/sai-chitra/4903?fromdate=2026-08-20"
  );
  assert.equal(result.shows.length, 1);
  assert.equal(result.shows[0].showTimeLabel, "11:00 AM");
  assert.equal(result.shows[0].showDateTime, "202608211100");
  assert.equal(result.shows[0].contentId, 123);
  assert.equal(result.shows[0].cutoffDateTime, "202608211115");
  assert.equal(result.shows[0].captureAt, "2026-08-21T05:40:00.000Z");
  assert.equal(result.shows[0].finalCaptureAt, "2026-08-21T05:44:00.000Z");
  assert.match(result.shows[0].seatLayoutUrl, /fromdate=2026-08-21$/);
});

test("captures sold seats from TicketNew per-class availability", () => {
  const show = discover(
    state,
    venue,
    "20260821",
    "https://ticketnew.com/movies/madanapalle/sai-chitra/4903"
  ).shows[0];
  const result = capture(state, { ...show, cinemaId: 4903, attemptId: "attempt" }, new Date("2026-08-21T05:44:05.000Z"));
  assert.deepEqual(result.categories, [
    { name: "RESERVED CL", price: 105, capacity: 317, available: 17, sold: 300, unknown: 0 },
    { name: "FIRST CL", price: 84, capacity: 107, available: 47, sold: 60, unknown: 0 }
  ]);
  assert.equal(result.attemptId, "attempt");
});

test("finds only the exact TicketNew session seat-layout link", () => {
  const links = [
    "https://ticketnew.com/movies/seat-layout/another-session?fromdate=2026-08-21",
    "https://ticketnew.com/movies/seat-layout/screen__session?encsessionid=4903-screen__session&fromdate=2026-08-21"
  ].map((href) => ({ href, getAttribute: () => href }));
  const document = {
    location: { href: "https://ticketnew.com/movies/madanapalle/sai-chitra/4903?fromdate=2026-08-21" },
    querySelectorAll: () => links
  };
  const show = { sessionId: "screen__session", dateCode: "20260821" };

  const url = findLiveSeatLayoutUrl(document, show);
  assert.match(url, /\/movies\/seat-layout\/screen__session/);
  assert.equal(isLiveSeatLayout({ href: url }, show), true);
  assert.equal(isLiveSeatLayout({ href: links[0].href }, show), false);
  assert.equal(isLiveSeatLayout({
    href: "https://ticketnew.com/movies/seat-layout/not-the-session?encsessionid=4903-prefixscreen__session_suffix&fromdate=2026-08-21"
  }, show), false);
  assert.equal(isLiveSeatLayout({
    href: "https://ticketnew.com/movies/seat-layout/screen__session?encsessionid=4903-screen__session&fromdate=2026-08-22"
  }, show), false);
});

test("selects a TicketNew show control by both movie and time", () => {
  const irumudi = ticketNewControl("11:00 AM", "Irumudi");
  const paradise = ticketNewControl("02:15 PM", "The Paradise");
  const otherParadise = ticketNewControl("11:00 AM", "The Paradise");
  const document = {
    querySelectorAll: (selector) => selector === '[role="button"]'
      ? [irumudi.control, paradise.control, otherParadise.control]
      : []
  };

  assert.equal(findSessionControl(document, {
    movieTitle: "The Paradise",
    showTimeLabel: "02:15 PM"
  }), paradise.control);
  assert.equal(findSessionControl(document, {
    movieTitle: "Irumudi",
    showTimeLabel: "11:00 AM"
  }), irumudi.control);
  assert.equal(findSessionControl(document, {
    movieTitle: "Unknown Movie",
    showTimeLabel: "11:00 AM"
  }), null);
});

test("refuses an ambiguous TicketNew movie and time control", () => {
  const first = ticketNewControl("09:15 PM", "Irumudi");
  const duplicate = ticketNewControl("09:15 PM", "Irumudi");
  const document = {
    querySelectorAll: () => [first.control, duplicate.control]
  };
  assert.equal(findSessionControl(document, {
    movieTitle: "Irumudi",
    showTimeLabel: "09:15 PM"
  }), null);
});

test("uses TicketNew content ID instead of guessing from a similar title", () => {
  const oldVersion = ticketNewControl("02:15 PM", "The Paradise", "111");
  const exactVersion = ticketNewControl("02:15 PM", "The Paradise", "222");
  const document = { querySelectorAll: () => [oldVersion.control, exactVersion.control] };

  assert.equal(findSessionControl(document, {
    contentId: 222,
    movieTitle: "The Paradise",
    showTimeLabel: "02:15 PM"
  }), exactVersion.control);
});

test("captures TicketNew sold seats from the live seat layout", () => {
  const labels = [
    "available  seat, class FIRST CL, row A, column 1, price 84",
    "unavailable seat, class FIRST CL, row A, column 2",
    "unavailable seat, class RESERVED CL, row B, column 1",
    "unavailable seat, class RESERVED CL, row B, column 2"
  ];
  const document = {
    querySelectorAll: () => labels.map((label) => ({ getAttribute: () => label }))
  };
  const result = captureLive(document, {
    naturalKey: "SCM:20260821:1100:screen__session:MOV1",
    attemptId: "live-attempt",
    categories: [
      { name: "FIRST CL", listPricePaise: 8_400 },
      { name: "RESERVED CL", listPricePaise: 10_500 }
    ]
  }, new Date("2026-08-21T05:44:40.000Z"));

  assert.deepEqual(result.categories, [
    { name: "FIRST CL", price: 84, capacity: 2, available: 1, sold: 1, unknown: 0 },
    { name: "RESERVED CL", price: 105, capacity: 2, available: 0, sold: 2, unknown: 0 }
  ]);
  assert.equal(result.attemptId, "live-attempt");
  assert.equal(result.capturedAt, "2026-08-21T05:44:40.000Z");
});

test("uses the TicketNew movie catalogue when a sold-out session is omitted from grouped metadata", () => {
  const soldOutState = structuredClone(state);
  const payload = soldOutState.props.pageProps.data.serverState.cinemaSessions["49032026-08-21"];
  payload.meta.movies = [];
  payload.pageData.sessions.push({
    ...payload.pageData.sessions[0],
    sid: "sold_out_session",
    showTime: "2026-08-21T15:45",
    closeTime: "2026-08-21T16:00",
    areas: payload.pageData.sessions[0].areas.map((area) => ({ ...area, sAvail: 0 }))
  });
  payload.pageData.arrangedSessions[0].sessions = [{ sid: "screen__session" }];
  soldOutState.props.pageProps.data.serverState.currentlyRunningMovies = {
    madanapalle: { data: { movies: [{ id: "MOV1", name: "Irumudi", label: "Irumudi", lang: "Telugu" }] } }
  };

  const result = discover(
    soldOutState,
    venue,
    "20260821",
    "https://ticketnew.com/movies/madanapalle/sai-chitra/4903"
  );
  const soldOut = result.shows.find((show) => show.sessionId === "sold_out_session");
  assert.equal(soldOut.movieTitle, "Irumudi");
  assert.equal(soldOut.movieVariant, "Irumudi");
  assert.equal(soldOut.eventCode, "MOV1");
});

function ticketNewControl(time, movieTitle, contentId = "") {
  const image = { getAttribute: (name) => name === "alt" ? `${movieTitle} Movie Poster` : null };
  const href = `/movies/${movieTitle.toLowerCase().replaceAll(" ", "-")}-movie-detail-${contentId || "123"}`;
  const link = { textContent: movieTitle, href, getAttribute: (name) => name === "href" ? href : null };
  const card = {
    parentElement: null,
    querySelector: (selector) => selector.includes("movie-detail") ? link : (selector === "img[alt]" ? image : null),
    querySelectorAll: (selector) => selector === "img[alt]" ? [image] : (selector.includes("movie-detail") ? [link] : [])
  };
  const wrapper = { parentElement: card, querySelector: () => null };
  const control = {
    textContent: time,
    parentElement: wrapper,
    getAttribute: () => null,
    click() {}
  };
  return { card, control };
}
