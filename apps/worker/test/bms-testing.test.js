import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  BMS_DISCOVERY_INTERVAL_MS,
  BMS_DISCOVERY_PREFLIGHT_MS,
  BMS_TESTING_VENUE_CODES,
  bmsCaptureClaimThrough,
  bmsCaptureWaitMs,
  bmsDiscoveryIsActionable,
  bmsTestingEnabled,
  decryptBmsSeatLayout,
  fetchBmsTestingCapture,
  normalizeServiceShows,
  nextBmsDiscoveryAt,
  parseBmsSeatCategories,
  parseBmsTheatreSchedule,
  parseDistrictSeatCategories,
  parseDistrictTheatreSchedule,
  validateServiceCapture
} from "../src/bms-testing.js";
import { venueForCode } from "../src/venues.js";

const KEY = "12345678901234567890123456789012";
const seatTokens = (code, status, count, start = 1) => Array.from({ length: count }, (_, index) => `${code}${status}${start + index}+x`);
const layout = () => `BALCONY:A:BA:1|RESERVED:B:RE:2|FIRST CLASS:C:FC:3|SECOND CLASS:D:SC:4||1:A:${[
  ...seatTokens("A", 1, 100), ...seatTokens("A", 2, 32, 101), ...seatTokens("A", 0, 3, 900)
].join(":")}|2:B:${[...seatTokens("B", 4, 200), ...seatTokens("B", 2, 13, 201)].join(":")}|3:C:${[
  ...seatTokens("C", 1, 90), ...seatTokens("C", 2, 22, 91)
].join(":")}|4:D:${[...seatTokens("D", 1, 150), ...seatTokens("D", 2, 30, 151)].join(":")}|`;
const show = {
  venue_code: "RTDM", session_id: "6624",
  advertised_categories_json: JSON.stringify([
    { name: "BALCONY", listPricePaise: 10_500 },
    { name: "RESERVED", listPricePaise: 10_500 },
    { name: "FIRST CLASS", listPricePaise: 10_500 },
    { name: "SECOND CLASS", listPricePaise: 10_500 }
  ])
};
const sunilLayout = () => `RESERVED:A:RE:1|FIRST CLASS:B:FC:2||1:A:${[
  ...seatTokens("A", 1, 200), ...seatTokens("A", 2, 39, 201)
].join(":")}|2:B:${[...seatTokens("B", 1, 80), ...seatTokens("B", 2, 8, 81)].join(":")}|`;
const sunilShow = {
  venue_code: "SUTD", session_id: "7788",
  advertised_categories_json: JSON.stringify([
    { name: "RESERVED", listPricePaise: 10_500 },
    { name: "FIRST CLASS", listPricePaise: 8_400 }
  ])
};

async function encryptedLayout() {
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(KEY), { name: "AES-CBC" }, false, ["encrypt"]);
  const encrypted = await webcrypto.subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, key, new TextEncoder().encode(layout()));
  return Buffer.from(encrypted).toString("base64");
}

test("automatic BMS testing remains explicitly disabled by default", () => {
  assert.deepEqual(BMS_TESTING_VENUE_CODES, ["RTDM", "ASRM", "SKMD", "MSDR", "SUTD", "SCM"]);
  assert.equal(BMS_DISCOVERY_INTERVAL_MS, 6 * 60 * 60_000);
  assert.equal(BMS_DISCOVERY_PREFLIGHT_MS, 30 * 60_000);
  assert.equal(bmsTestingEnabled({ BMS_CAPTURE_SERVICE_URL: "https://capture.example", BMS_CAPTURE_SERVICE_TOKEN: KEY }), false);
  assert.equal(bmsTestingEnabled({ BMS_TESTING_ENABLED: "true", BMS_CAPTURE_SERVICE_URL: "https://capture.example", BMS_CAPTURE_SERVICE_TOKEN: KEY }), true);
  assert.equal(bmsTestingEnabled({ BMS_TESTING_ENABLED: "true", BMS_CAPTURE_SERVICE_URL: "http://capture.example", BMS_CAPTURE_SERVICE_TOKEN: KEY }), false);
  assert.equal(bmsTestingEnabled({ BMS_TESTING_ENABLED: "true", BMS_CAPTURE_SERVICE_URL: "internal" }), false);
  assert.equal(bmsTestingEnabled({ BMS_TESTING_ENABLED: "true", BMS_CAPTURE_SERVICE_URL: "internal", BMS_LAYOUT_KEY: KEY }), true);
});

test("server discovery refreshes before a pending show without excessive polling", () => {
  const shows = [
    { startAt: "2026-11-28T05:30:00.000Z" },
    { startAt: "2026-11-28T08:45:00.000Z" }
  ];
  assert.equal(
    nextBmsDiscoveryAt(shows, "2026-11-28T00:31:00.000Z"),
    "2026-11-28T05:00:00.000Z",
    "the 11 AM show receives a 10:30 AM IST schedule preflight"
  );
  assert.equal(
    nextBmsDiscoveryAt(shows, "2026-11-28T05:01:00.000Z"),
    "2026-11-28T08:15:00.000Z",
    "after the morning preflight, discovery advances to the next show"
  );
  assert.equal(
    nextBmsDiscoveryAt([], "2026-11-28T00:31:00.000Z"),
    "2026-11-28T02:31:00.000Z",
    "an empty schedule is checked again sooner instead of waiting half a day"
  );
});

test("minute cron reserves the next cutoff and waits for its exact due time", () => {
  assert.equal(bmsCaptureClaimThrough("2026-11-27T08:43:56.800Z"), "2026-11-27T08:44:00.000Z");
  assert.equal(bmsCaptureClaimThrough("2026-11-27T08:44:00.000Z"), "2026-11-27T08:44:00.000Z");
  assert.equal(bmsCaptureWaitMs("2026-11-27T08:44:00.000Z", "2026-11-27T08:43:56.800Z"), 3_200);
  assert.equal(bmsCaptureWaitMs("2026-11-27T08:44:00.000Z", "2026-11-27T08:44:02.000Z"), 0);
});

test("completed historical dates do not expose stale discovery failures", () => {
  const completed = [{ jobs: { final: { status: "succeeded", deadlineAt: "2026-11-27T16:20:00.000Z" } } }];
  assert.equal(bmsDiscoveryIsActionable("2026-11-27", completed, "2026-11-27T23:30:00.000Z"), false);
  assert.equal(bmsDiscoveryIsActionable("2026-11-28", [], "2026-11-27T23:30:00.000Z"), true);
  assert.equal(bmsDiscoveryIsActionable("2026-11-28", [{ jobs: { final: { status: "pending" } } }], "2026-11-27T23:30:00.000Z"), true);
});

test("all six server testing theatres require their verified real-seat capacities", () => {
  const expectedCapacities = { RTDM: 637, ASRM: 520, SKMD: 657, MSDR: 271, SUTD: 327, SCM: 424 };
  for (const venueCode of BMS_TESTING_VENUE_CODES) {
    const venue = venueForCode(venueCode);
    const definitions = venue.layoutCategories.map((category, index) => `${category.name}:${String.fromCharCode(65 + index)}:X:${index + 1}`);
    const rows = venue.layoutCategories.map((category, index) => {
      const code = String.fromCharCode(65 + index);
      return `${index + 1}:${code}:${[
        ...seatTokens(code, 1, category.capacity - 1),
        ...seatTokens(code, 2, 1, category.capacity)
      ].join(":")}`;
    });
    const venueShow = {
      venue_code: venueCode,
      advertised_categories_json: JSON.stringify(venue.layoutCategories.map((category) => ({
        name: category.name,
        listPricePaise: 10_500
      })))
    };
    const result = parseBmsSeatCategories(`${definitions.join("|")}||${rows.join("|")}|`, venueShow);
    assert.equal(result.capacity, expectedCapacities[venueCode], venue.shortName);
    assert.equal(result.sold, venue.layoutCategories.length, venue.shortName);
  }
});

test("Mini Siddartha excludes the blocked Silver section until BMS opens it", () => {
  const silver = [
    ...seatTokens("B", 1, 25),
    ...seatTokens("B", 2, 8, 26),
    ...seatTokens("B", 2, 16, 34)
  ];
  const miniLayout = `GOLD CLASS:A:GO:1|SILVER CLASS:B:SI:2||1:A:${[
    ...seatTokens("A", 1, 200), ...seatTokens("A", 2, 38, 201)
  ].join(":")}|2:B:${silver.join(":")}|`;
  const miniShow = {
    venue_code: "MSDR",
    advertised_categories_json: JSON.stringify([
      { name: "GOLD CLASS", listPricePaise: 10_500 },
      { name: "SILVER CLASS", listPricePaise: 8_400 }
    ])
  };
  const current = parseBmsSeatCategories(miniLayout, miniShow);
  assert.equal(current.capacity, 271);
  assert.equal(current.sold, 46);
  assert.equal(current.collectionPaise, 443_200);

  const expanded = parseBmsSeatCategories(miniLayout.replace("B234+x", "B134+x"), miniShow);
  assert.equal(expanded.capacity, 287);
  assert.equal(expanded.sold, 61);
});

test("Sunil parser requires its verified 239 plus 88 seat layout", () => {
  const result = parseBmsSeatCategories(sunilLayout(), sunilShow);
  assert.equal(result.capacity, 327);
  assert.equal(result.sold, 47);
  assert.equal(result.collectionPaise, 453_200);
  assert.throws(() => parseBmsSeatCategories(sunilLayout().replace("A2239+x", "A0239+x"), sunilShow), /expected 239/);
});

test("seat parser ignores phantom positions and preserves verified capacities", () => {
  const result = parseBmsSeatCategories(layout(), show);
  assert.equal(result.capacity, 637);
  assert.equal(result.sold, 97);
  assert.equal(result.collectionPaise, 970_000);
});

test("seat parser rejects partial layouts instead of saving incorrect counts", () => {
  assert.throws(() => parseBmsSeatCategories(layout().replace("B2201+x", "B0201+x"), show), /expected 213/);
});

test("historical encrypted fixture decoding remains available for offline verification", async () => {
  const encoded = await encryptedLayout();
  assert.equal(await decryptBmsSeatLayout(encoded, KEY, webcrypto), layout());
  const result = await fetchBmsTestingCapture(show, {
    keyText: KEY,
    cryptoImpl: webcrypto,
    fetchImpl: async (_url, options) => {
      assert.equal(options.body.get("strVenueCode"), "RTDM");
      assert.equal(options.body.get("strParam1"), "6624");
      return { ok: true, async json() { return { BookMyShow: { blnSuccess: "true", strData: encoded } }; } };
    }
  });
  assert.equal(result.sold, 97);
});

test("explicit BMS sold-out responses become verified full-capacity captures", async () => {
  const soldOutResponse = (message) => async () => ({
    ok: true,
    async json() { return { BookMyShow: { blnSuccess: "false", strException: message } }; }
  });
  const ravi = await fetchBmsTestingCapture(show, {
    fetchImpl: soldOutResponse("It seems seats are sold out hence we can't proceed further. Please check another show. (#159)")
  });
  assert.equal(ravi.capacity, 637);
  assert.equal(ravi.available, 0);
  assert.equal(ravi.sold, 637);
  assert.equal(ravi.occupancyPercent, 100);
  assert.equal(ravi.collectionPaise, 6_370_000);
  assert.equal(ravi.captureEvidence, "provider_sold_out");

  const sunil = await fetchBmsTestingCapture(sunilShow, {
    fetchImpl: soldOutResponse("No available seats for this show")
  });
  assert.equal(sunil.capacity, 327);
  assert.equal(sunil.available, 0);
  assert.equal(sunil.sold, 327);
  assert.equal(sunil.occupancyPercent, 100);
  assert.equal(sunil.collectionPaise, 3_085_200);
  assert.equal(sunil.captureEvidence, "provider_sold_out");
});

test("generic missing BMS data is never treated as sold out", async () => {
  await assert.rejects(() => fetchBmsTestingCapture(show, {
    fetchImpl: async () => ({
      ok: true,
      async json() { return { BookMyShow: { blnSuccess: "false", strException: "Seat data is temporarily unavailable" } }; }
    })
  }), /temporarily unavailable/);
});

test("theatre page discovery produces server capture timings", () => {
  const state = {
    venueShowtimesFunctionalApi: { queries: {
      "getShowtimesByVenue-RTDM-20261116": { data: { showDetailsTransformed: { Event: [{
        EventTitle: "Test Movie",
        ChildEvents: [{ EventCode: "ET001", EventName: "Test Movie - Telugu", EventLanguage: "Telugu", EventDimension: "2D", ShowTimes: [{
          SessionId: "6624", ShowTimeCode: "1100", ShowTime: "11:00 AM",
          ShowDateTime: "202611161100", CutOffDateTime: "202611161115",
          Categories: [{ PriceDesc: "BALCONY", PriceCode: "A", CurPrice: 105 }]
        }] }]
      }] } } }
    } }
  };
  const html = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script>`;
  const shows = parseBmsTheatreSchedule(html, venueForCode("RTDM"), "2026-11-16", new Date("2026-11-15T23:00:00.000Z"));
  assert.equal(shows.length, 1);
  assert.equal(shows[0].captureAt, "2026-11-16T05:45:00.000Z");
  assert.equal(shows[0].finalCaptureAt, "2026-11-16T05:44:00.000Z");
  assert.equal(shows[0].categories[0].listPricePaise, 10_500);
});

test("District discovery preserves Sai Chitra's exact session route and class prices", () => {
  const state = {
    props: { pageProps: { initialState: { movies: { cinemaSessions: {
      "49032026-11-28": {
        meta: { cinema: { id: 4903 } },
        arrangedSessions: [{
          entityName: "O.M: Operation Mole",
          data: { name: "O.M: Operation Mole", contentId: 225928, lang: "Telugu", formatGroupIds: ["wtxilzqzsr"] },
          sessions: [{
            sid: "35453__1795843800__753__2326006", cid: 4903, mid: "OBAVDF", fid: "WTxilZqZsr",
            showTime: "2026-11-28T05:30", closeTime: "2026-11-28T05:45",
            showTimeISO: "2026-11-28T11:00:00+05:30", showTimeText: "11:00 AM", showDate: "2026-11-28",
            lang: "Telugu", scrnFmt: "2D", audi: "SP SAI CHITRA 4K LASER", contentId: 225928,
            encSessionId: "4903-35453__1795843800__753__2326006-obavdf-wtxilzqzsr",
            areas: [
              { code: "1419", label: "RESERVED CL", price: 105 },
              { code: "1420", label: "FIRST CL", price: 84 }
            ]
          }]
        }]
      }
    } } } } }
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script>`;
  const shows = parseDistrictTheatreSchedule(html, venueForCode("SCM"), "2026-11-28", new Date("2026-11-27T23:30:00.000Z"));
  assert.equal(shows.length, 1);
  assert.equal(shows[0].provider, "district");
  assert.equal(shows[0].sessionId, "35453__1795843800__753__2326006");
  assert.equal(shows[0].startAt, "2026-11-28T05:30:00.000Z");
  assert.equal(shows[0].cutoffAt, "2026-11-28T05:45:00.000Z");
  assert.equal(shows[0].finalCaptureAt, "2026-11-28T05:44:00.000Z");
  assert.match(shows[0].providerUrl, /^https:\/\/www\.district\.in\/movies\/seat-layout\/wtxilzqzsr\?/);
  assert.match(shows[0].providerUrl, /encsessionid=4903-35453__1795843800__753__2326006-obavdf-wtxilzqzsr/);
  assert.deepEqual(shows[0].categories.map((item) => item.listPricePaise), [10_500, 8_400]);
});

test("District seat parser counts Sai Chitra unavailable seats and rejects partial maps", () => {
  const labels = [
    ...Array.from({ length: 300 }, (_, index) => `available seat ${index + 1}, class RESERVED CL, price 105`),
    ...Array.from({ length: 17 }, (_, index) => `unavailable seat ${index + 301}, class RESERVED CL, price 105`),
    ...Array.from({ length: 100 }, (_, index) => `available seat ${index + 1}, class FIRST CL, price 84`),
    ...Array.from({ length: 7 }, (_, index) => `unavailable seat ${index + 101}, class FIRST CL, price 84`)
  ];
  const districtShow = {
    venue_code: "SCM",
    advertised_categories_json: JSON.stringify([
      { name: "RESERVED CL", listPricePaise: 10_500 },
      { name: "FIRST CL", listPricePaise: 8_400 }
    ])
  };
  const result = parseDistrictSeatCategories(labels, districtShow);
  assert.equal(result.capacity, 424);
  assert.equal(result.sold, 24);
  assert.equal(result.collectionPaise, 225_300);
  assert.throws(() => parseDistrictSeatCategories(labels.slice(0, -1), districtShow), /expected 107/);
});

test("capture-service discovery schedules only the nineteenth-minute Ravi read", () => {
  const shows = normalizeServiceShows({
    venueCode: "RTDM",
    showDate: "2026-11-27",
    shows: [{
      showTimeCode: "1100", showTimeLabel: "11:00 AM", startAt: "2026-11-27T05:30:00.000Z",
      cutoffAt: "2026-11-27T05:50:00.000Z", sessionId: "1234", eventCode: "ET001",
      movieTitle: "Test Movie", categories: [{ name: "BALCONY", listPricePaise: 10_500 }]
    }]
  }, venueForCode("RTDM"), "2026-11-27", "2026-11-26T23:00:00.000Z");
  assert.equal(shows[0].finalCaptureAt, "2026-11-27T05:49:00.000Z");
  assert.equal(shows[0].captureAt, shows[0].finalCaptureAt);
});

test("Worker accepts only a complete Ravi service result", () => {
  const categories = [
    ["BALCONY", 132, 100, 32], ["RESERVED", 213, 200, 13],
    ["FIRST CLASS", 112, 90, 22], ["SECOND CLASS", 180, 150, 30]
  ].map(([name, capacity, available, unavailable]) => ({ name, capacity, available, unavailable, unknown: 0, listPricePaise: 10_500 }));
  const result = validateServiceCapture({ venueCode: "RTDM", sessionId: "6624", categories }, show);
  assert.equal(result.capacity, 637);
  assert.equal(result.sold, 97);
  assert.throws(() => validateServiceCapture({ venueCode: "RTDM", sessionId: "6624", categories: categories.map((item, index) => index ? item : { ...item, capacity: 131 }) }, show), /expected 132/);
});

test("Worker accepts only Sunil's verified 327-seat service result", () => {
  const categories = [
    { name: "RESERVED", capacity: 239, available: 200, unavailable: 39, unknown: 0, listPricePaise: 10_500 },
    { name: "FIRST CLASS", capacity: 88, available: 80, unavailable: 8, unknown: 0, listPricePaise: 8_400 }
  ];
  const result = validateServiceCapture({ venueCode: "SUTD", sessionId: "7788", categories }, sunilShow);
  assert.equal(result.capacity, 327);
  assert.equal(result.sold, 47);
  assert.throws(() => validateServiceCapture({ venueCode: "SUTD", sessionId: "7788", categories: categories.map((item, index) => index ? item : { ...item, capacity: 238 }) }, sunilShow), /expected 239/);
});
