import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentShows } from "../src/agent.js";

test("local agent discovery is normalized and capture time is server-calculated", () => {
  const [show] = normalizeAgentShows({
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
      categories: [{ name: "RESERVED CLASS", listPricePaise: 10500 }]
    }]
  });
  assert.equal(show.naturalKey, "SKMD:20260820:1100:6220:ET00510230");
  assert.equal(show.captureAt, "2026-08-20T05:40:00.000Z");
});

test("Ravi discovery uses its live BookMyShow cutoff", () => {
  const [show] = normalizeAgentShows({
    venueCode: "RTDM",
    dateCode: "20260820",
    shows: [{
      eventCode: "ET00510230",
      sessionId: "16642",
      showTimeCode: "1100",
      showTimeLabel: "11:00 AM",
      showDateTime: "202608201100",
      cutoffDateTime: "202608201120",
      movieTitle: "Vishwanath and Sons",
      categories: [{ name: "BALCONY", listPricePaise: 10500 }]
    }]
  });
  assert.equal(show.naturalKey, "RTDM:20260820:1100:16642:ET00510230");
  assert.equal(show.captureAt, "2026-08-20T05:45:00.000Z");
});

test("Sai Chitra discovery accepts only its TicketNew cinema URL", () => {
  const [show] = normalizeAgentShows({
    venueCode: "SCM",
    dateCode: "20260820",
    shows: [{
      eventCode: "OBAV6L",
      sessionId: "34956__1787301900__753__1867461",
      showTimeCode: "1100",
      showTimeLabel: "11:00 AM",
      showDateTime: "202608201100",
      cutoffDateTime: "202608201115",
      movieTitle: "Irumudi",
      seatLayoutUrl: "https://ticketnew.com/movies/madanapalle/sai-chitra-theatre-a-c-4k-dolby-surround-7-1-madanapalle-c/4903?fromdate=2026-08-20",
      categories: [{ name: "RESERVED CL", listPricePaise: 10500 }]
    }]
  });
  assert.equal(show.captureAt, "2026-08-20T05:40:00.000Z");
  assert.match(show.seatLayoutUrl, /^https:\/\/ticketnew\.com\/.*\/4903\?/);
});
