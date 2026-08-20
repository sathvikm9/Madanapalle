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
