import assert from "node:assert/strict";
import test from "node:test";

await import("./ticketnew.js");
const { discover, capture } = globalThis.SKCTTicketNew;

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
