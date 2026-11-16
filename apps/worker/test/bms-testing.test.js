import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  bmsTestingEnabled,
  decryptBmsSeatLayout,
  fetchBmsTestingCapture,
  parseBmsSeatCategories,
  parseBmsTheatreSchedule
} from "../src/bms-testing.js";
import { venueForCode } from "../src/venues.js";

const KEY = "12345678901234567890123456789012";
const seatTokens = (code, status, count, start = 1) => Array.from({ length: count }, (_, index) => `${code}${status}${start + index}+x`);
const layout = () => `RESERVED CLASS:A:x|SECOND CLASS:B:x||1:A:${[
  ...seatTokens("A", 1, 400), ...seatTokens("A", 2, 93, 401), ...seatTokens("A", 0, 3, 900)
].join(":")}|1:A:${[...seatTokens("B", 1, 100), ...seatTokens("B", 2, 64, 101)].join(":")}|`;
const show = {
  venue_code: "SKMD", session_id: "6624",
  advertised_categories_json: JSON.stringify([
    { name: "RESERVED CLASS", listPricePaise: 10_500 },
    { name: "SECOND CLASS", listPricePaise: 8_400 }
  ])
};

async function encryptedLayout() {
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(KEY), { name: "AES-CBC" }, false, ["encrypt"]);
  const encrypted = await webcrypto.subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, key, new TextEncoder().encode(layout()));
  return Buffer.from(encrypted).toString("base64");
}

test("automatic BMS testing remains explicitly disabled by default", () => {
  assert.equal(bmsTestingEnabled({ BMS_LAYOUT_KEY: KEY }), false);
  assert.equal(bmsTestingEnabled({ BMS_TESTING_ENABLED: "true", BMS_LAYOUT_KEY: KEY }), true);
});

test("seat parser ignores phantom positions and preserves verified capacities", () => {
  const result = parseBmsSeatCategories(layout(), show);
  assert.equal(result.capacity, 657);
  assert.equal(result.sold, 157);
  assert.equal(result.collectionPaise, 1_435_600);
});

test("seat parser rejects partial layouts instead of saving incorrect counts", () => {
  assert.throws(() => parseBmsSeatCategories(layout().replace("B2101+x", "B0101+x"), show), /expected 164/);
});

test("encrypted response is decoded and parsed without a browser", async () => {
  const encoded = await encryptedLayout();
  assert.equal(await decryptBmsSeatLayout(encoded, KEY, webcrypto), layout());
  const result = await fetchBmsTestingCapture(show, {
    keyText: KEY,
    cryptoImpl: webcrypto,
    fetchImpl: async (_url, options) => {
      assert.equal(options.body.get("strVenueCode"), "SKMD");
      assert.equal(options.body.get("strParam1"), "6624");
      return { ok: true, async json() { return { BookMyShow: { blnSuccess: "true", strData: encoded } }; } };
    }
  });
  assert.equal(result.sold, 157);
});

test("theatre page discovery produces server capture timings", () => {
  const state = {
    venueShowtimesFunctionalApi: { queries: {
      "getShowtimesByVenue-SKMD-20261116": { data: { showDetailsTransformed: { Event: [{
        EventTitle: "Test Movie",
        ChildEvents: [{ EventCode: "ET001", EventName: "Test Movie - Telugu", EventLanguage: "Telugu", EventDimension: "2D", ShowTimes: [{
          SessionId: "6624", ShowTimeCode: "1100", ShowTime: "11:00 AM",
          ShowDateTime: "202611161100", CutOffDateTime: "202611161115",
          Categories: [{ PriceDesc: "RESERVED CLASS", PriceCode: "A", CurPrice: 105 }, { PriceDesc: "SECOND CLASS", PriceCode: "B", CurPrice: 84 }]
        }] }]
      }] } } }
    } }
  };
  const html = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script>`;
  const shows = parseBmsTheatreSchedule(html, venueForCode("SKMD"), "2026-11-16", new Date("2026-11-15T23:00:00.000Z"));
  assert.equal(shows.length, 1);
  assert.equal(shows[0].captureAt, "2026-11-16T05:40:00.000Z");
  assert.equal(shows[0].finalCaptureAt, "2026-11-16T05:44:00.000Z");
  assert.equal(shows[0].categories[0].listPricePaise, 10_500);
});
