import test from "node:test";
import assert from "node:assert/strict";
import { formatFullGrossAnswer, parseFullGrossQuestion } from "./fullGrossCalculator.js";

const catalog = {
  movies: [{ title: "Irumudi" }, { title: "Toxic: A Fairy Tale for Grown-ups" }],
  capacityProfiles: [
    { venueCode: "SCM", theatreName: "Sai Chitra", capacity: 424, tiers: [
      { listPricePaise: 10500, capacity: 317, classes: ["RESERVED CL"] },
      { listPricePaise: 8400, capacity: 107, classes: ["FIRST CL"] }
    ] },
    { venueCode: "ASRM", theatreName: "ASR", capacity: 520, tiers: [
      { listPricePaise: 10500, capacity: 386, classes: ["RESERVED"] },
      { listPricePaise: 8400, capacity: 134, classes: ["SECOND CLASS"] }
    ] },
    { venueCode: "RTDM", theatreName: "Ravi", capacity: 637, tiers: [
      { listPricePaise: 17000, capacity: 457, classes: ["BALCONY", "RESERVED", "FIRST CLASS"] },
      { listPricePaise: 10000, capacity: 180, classes: ["SECOND CLASS"] }
    ] },
    { venueCode: "SKMD", theatreName: "Sri Krishna", capacity: 657, tiers: [
      { listPricePaise: 10500, capacity: 493, classes: ["RESERVED CLASS"] },
      { listPricePaise: 8400, capacity: 164, classes: ["SECOND CLASS"] }
    ] }
  ]
};

test("calculates Sai Chitra custom full-show and five-show gross", () => {
  const first = parseFullGrossQuestion("Sai Chitra with 170 and 100rs", catalog).request;
  const followUp = parseFullGrossQuestion("with this gross, 5 shows how much?", catalog, first).request;
  const answer = formatFullGrossAnswer(followUp, catalog);
  assert.deepEqual(first.prices, [170, 100]);
  assert.equal(followUp.showCount, 5);
  assert.match(answer, /317 × ₹165 = ₹52,305/);
  assert.match(answer, /107 × ₹95 = ₹10,165/);
  assert.match(answer, /One full show: ₹62,470/);
  assert.match(answer, /5 full shows: ₹3,12,350/);
});

test("understands a short theatre and price-pair request", () => {
  const parsed = parseFullGrossQuestion("Ravi 170 and 100rs", catalog).request;
  const answer = formatFullGrossAnswer(parsed, catalog);
  assert.deepEqual(parsed.venueCodes, ["RTDM"]);
  assert.deepEqual(parsed.prices, [170, 100]);
  assert.match(answer, /Ravi · 637 seats/);
  assert.match(answer, /One full show: ₹92,505/);
});

test("understands theatre codes, bare price pairs and x multipliers", () => {
  const first = parseFullGrossQuestion("rv 170 100", catalog).request;
  assert.deepEqual(first.venueCodes, ["RTDM"]);
  assert.deepEqual(first.prices, [170, 100]);

  const multiplied = parseFullGrossQuestion("x5", catalog, first).request;
  assert.equal(multiplied.showCount, 5);
  assert.deepEqual(multiplied.prices, [170, 100]);
  assert.match(formatFullGrossAnswer(multiplied, catalog), /5 full shows: ₹4,62,525/);
});

test("understands an all-theatre calculator shortcut", () => {
  const parsed = parseFullGrossQuestion("all 200 150 full", catalog).request;
  assert.equal(parsed.venueCodes.length, 4);
  assert.deepEqual(parsed.prices, [200, 150]);
});

test("calculates shared prices across selected theatres", () => {
  const parsed = parseFullGrossQuestion(
    "Calculate 200 and 150rs each show gross for Sai Chitra, ASR and Sri Krishna",
    catalog
  ).request;
  const answer = formatFullGrossAnswer(parsed, catalog);
  assert.deepEqual(parsed.venueCodes, ["SCM", "ASRM", "SKMD"]);
  assert.match(answer, /Sai Chitra · 424 seats/);
  assert.match(answer, /One full show: ₹77,330/);
  assert.match(answer, /ASR · 520 seats[\s\S]*One full show: ₹94,700/);
  assert.match(answer, /Sri Krishna · 657 seats[\s\S]*One full show: ₹1,19,915/);
});

test("inherits selected theatres and prices for a five-shows-each follow-up", () => {
  const first = parseFullGrossQuestion(
    "Calculate 200 and 150rs each show gross for Sai Chitra, ASR and Sri Krishna",
    catalog
  ).request;
  const next = parseFullGrossQuestion("with this gross, each theatre 5 shows how much?", catalog, first).request;
  assert.deepEqual(next.venueCodes, ["SCM", "ASRM", "SKMD"]);
  assert.deepEqual(next.prices, [200, 150]);
  assert.equal(next.showCount, 5);
  assert.match(formatFullGrossAnswer(next, catalog), /Combined 5-shows-each total: ₹14,59,725/);
});

test("uses latest recorded prices for an all-theatre full-show question", () => {
  const parsed = parseFullGrossQuestion("What is all theatres each show full gross?", catalog).request;
  const answer = formatFullGrossAnswer(parsed, catalog);
  assert.equal(parsed.venueCodes.length, 4);
  assert.equal(parsed.prices, null);
  assert.match(answer, /Using the latest listed ticket prices/);
  assert.match(answer, /Ravi · 637 seats/);
});

test("does not steal ordinary movie analytics questions", () => {
  assert.equal(parseFullGrossQuestion("How many Irumudi shows are full?", catalog), null);
  assert.equal(parseFullGrossQuestion("What is Toxic gross?", catalog, { mode: "full_gross" }), null);
});
