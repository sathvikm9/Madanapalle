import { calculateCollection } from "@skct/core";
import puppeteer from "@cloudflare/puppeteer";
import { venueForCode } from "./venues.js";

const BMS_BASE = "https://in.bookmyshow.com";
const BMS_HOME = `${BMS_BASE}/explore/home/madanapalle`;
const BMS_SEAT_ENDPOINT = "https://services-in.bookmyshow.com/doTrans.aspx";
const DISTRICT_BASE = "https://www.district.in";
export const BMS_DISCOVERY_INTERVAL_MS = 12 * 60 * 60_000;
const DISCOVERY_RETRY_MS = 2 * 60 * 60_000;
const RETRY_MS = 60_000;
const RATE_LIMIT_RETRY_MS = 30 * 60_000;
const MAX_CAPTURES_PER_RUN = 8;
const CAPTURE_LEASE_MS = 180_000;
const CAPTURE_SPACING_MS = 1_000;
export const BMS_TESTING_VENUE_CODES = Object.freeze(["RTDM", "ASRM", "SKMD", "MSDR", "SUTD", "SCM"]);
const VENUE_SET = new Set(BMS_TESTING_VENUE_CODES);

export class BmsUpstreamError extends Error {
  constructor(message, { status = null, code = "bms_upstream_error", retryAfterMs = null, stage = null } = {}) {
    super(message);
    this.name = "BmsUpstreamError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.stage = stage;
  }
}

const jsonValue = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const addMs = (value, ms) => new Date(new Date(value).getTime() + ms).toISOString();
const elapsedMs = (started, finished) => Math.max(0, new Date(finished).getTime() - new Date(started).getTime());
const dateCode = (value) => String(value || "").replaceAll("-", "");
const normalizedName = (value) => String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
const sleep = (ms) => ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

// Cloudflare's minute cron can arrive near the end of its minute. Reserve a
// capture due at the next minute boundary, then wait for that exact due time.
// This preserves the full BMS cutoff minute instead of first starting at :56.
export function bmsCaptureClaimThrough(now = new Date()) {
  const value = new Date(now);
  if (!Number.isFinite(value.getTime())) throw new TypeError("Invalid scheduler time");
  if (value.getUTCSeconds() || value.getUTCMilliseconds()) {
    value.setUTCMinutes(value.getUTCMinutes() + 1, 0, 0);
  }
  return value.toISOString();
}

export function bmsCaptureWaitMs(dueAt, now = new Date()) {
  const due = new Date(dueAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(due) || !Number.isFinite(current)) throw new TypeError("Invalid capture time");
  return Math.max(0, due - current);
}

function indiaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function bmsDiscoveryIsActionable(showDate, shows = [], now = new Date()) {
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) throw new TypeError("Invalid discovery health time");
  if (String(showDate || "") < indiaDate(current)) return false;
  if (!shows.length) return true;
  return shows.some((show) => {
    const job = show?.jobs?.final || {};
    if (job.status === "pending" || job.status === "running") return true;
    const deadline = new Date(job.deadlineAt || 0).getTime();
    return Number.isFinite(deadline) && deadline >= current.getTime();
  });
}

function codeToDate(code) {
  const value = String(code || "");
  if (!/^\d{12}$/.test(value)) throw new BmsUpstreamError("BMS returned an invalid show timestamp", { code: "schema_changed" });
  return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:00+05:30`);
}

function retryAfterMs(response) {
  const value = response.headers?.get?.("retry-after");
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export function isBmsTestingVenue(code) { return VENUE_SET.has(String(code || "").toUpperCase()); }
export function bmsTestingEnabled(env) {
  if (String(env.BMS_TESTING_ENABLED || "").toLowerCase() !== "true") return false;
  if (String(env.BMS_CAPTURE_SERVICE_URL || "").trim() === "internal") {
    return String(env.BMS_LAYOUT_KEY || "").length === 32;
  }
  if (String(env.BMS_CAPTURE_SERVICE_TOKEN || "").trim().length < 24) return false;
  try {
    const url = new URL(String(env.BMS_CAPTURE_SERVICE_URL || ""));
    return url.protocol === "https:" || ["127.0.0.1", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}

function internalCaptureService(env) {
  return String(env.BMS_CAPTURE_SERVICE_URL || "").trim() === "internal";
}

function captureServiceUrl(env, path) {
  return new URL(path, `${String(env.BMS_CAPTURE_SERVICE_URL).replace(/\/$/, "")}/`).toString();
}

async function callCaptureService(env, path, payload, options = {}) {
  const response = await (options.fetchImpl || fetch)(captureServiceUrl(env, path), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.BMS_CAPTURE_SERVICE_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload),
    // A cold Chromium adapter may need time to start and warm the normal BMS
    // pages before returning schedule data. The D1 lease remains the outer
    // bound, so this timeout only protects a genuinely stalled adapter.
    signal: options.signal || AbortSignal.timeout(90_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new BmsUpstreamError(result.message || `BMS capture service returned HTTP ${response.status}`, {
      status: response.status,
      code: result.code || (response.status === 429 ? "rate_limited" : response.status === 403 ? "forbidden" : "capture_service_error"),
      retryAfterMs: retryAfterMs(response)
    });
  }
  return result;
}

export async function decryptBmsSeatLayout(encryptedText, keyText, cryptoImpl = crypto) {
  if (!encryptedText) throw new Error("BMS did not return encrypted seat data");
  if (String(keyText || "").length !== 32) throw new Error("BMS_LAYOUT_KEY must be exactly 32 characters");
  const bytes = Uint8Array.from(atob(encryptedText), (character) => character.charCodeAt(0));
  const key = await cryptoImpl.subtle.importKey("raw", new TextEncoder().encode(keyText), { name: "AES-CBC" }, false, ["decrypt"]);
  const decrypted = await cryptoImpl.subtle.decrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, key, bytes);
  return new TextDecoder().decode(decrypted);
}

function definitions(header) {
  const parsed = String(header || "").split("|").filter(Boolean).map((item) => {
    const [name, code] = item.split(":");
    return { name: normalizedName(name), code: String(code || "").trim().toUpperCase() };
  }).filter((item) => item.name && item.code);
  if (!parsed.length || new Set(parsed.map((item) => item.code)).size !== parsed.length) {
    throw new Error("BMS returned invalid seat categories");
  }
  return parsed;
}

export function parseBmsSeatCategories(text, show) {
  const [header, body] = String(text || "").split("||");
  const categoryDefinitions = definitions(header);
  const rows = String(body || "").split("|").filter(Boolean);
  if (!rows.length) throw new Error("BMS returned an unknown seat-layout format");
  const counts = new Map(categoryDefinitions.map((item) => [item.code, {
    available: 0, sold: 0, unknown: 0, statuses: []
  }]));
  for (const row of rows) {
    const [, , ...seats] = row.split(":");
    for (const seat of seats) {
      const token = String(seat.split("+")[0] || "");
      const count = counts.get(token.charAt(0).toUpperCase());
      const status = Number.parseInt(token.charAt(1), 10);
      if (!count || !Number.isInteger(status)) throw new Error("BMS returned an unrecognized seat token");
      if (status === 1 || status === 4) { count.available += 1; count.statuses.push(status); }
      else if (status === 2) { count.sold += 1; count.statuses.push(status); }
      else if (status !== 0) { count.unknown += 1; count.statuses.push(status); }
    }
  }
  const venue = venueForCode(show.venue_code || show.venueCode);
  if (!venue || !isBmsTestingVenue(venue.venueCode)) throw new Error("Venue is not approved for BMS testing");
  const expected = new Map(venue.layoutCategories.map((item) => [normalizedName(item.name), item]));
  const prices = new Map(jsonValue(show.advertised_categories_json, []).map((item) => [normalizedName(item.name), Number(item.listPricePaise || 0)]));
  if (categoryDefinitions.length !== expected.size) throw new Error(`Rejected ${venue.shortName} layout: expected ${expected.size} categories, received ${categoryDefinitions.length}`);
  const categories = categoryDefinitions.map((item) => {
    const layout = expected.get(item.name);
    if (!layout) throw new Error(`Rejected ${venue.shortName} layout: unknown category ${item.name}`);
    const observed = counts.get(item.code);
    const observedCapacity = observed.available + observed.sold + observed.unknown;
    const physicalCapacity = Number(layout.physicalCapacity || layout.capacity);
    if (observedCapacity !== layout.capacity && observedCapacity !== physicalCapacity) {
      throw new Error(`Rejected ${venue.shortName} ${layout.name}: counted ${observedCapacity} real seats, expected ${layout.capacity}${physicalCapacity !== layout.capacity ? ` or ${physicalCapacity}` : ""}`);
    }
    let count = observed;
    // Mini Siddartha's optional Silver block is currently exposed by BMS as
    // unavailable. Keep it outside the denominator until at least one of those
    // positions is actually opened; then accept the complete 49-seat section.
    if (physicalCapacity !== layout.capacity && observedCapacity === physicalCapacity) {
      const optionalCapacity = Number(layout.optionalCapacity || physicalCapacity - layout.capacity);
      const baseStatuses = observed.statuses.slice(0, physicalCapacity - optionalCapacity);
      const optionalStatuses = observed.statuses.slice(-optionalCapacity);
      const optionalSectionOpen = optionalStatuses.some((status) => status === 1 || status === 4);
      if (!optionalSectionOpen) {
        count = baseStatuses.reduce((result, status) => {
          if (status === 1 || status === 4) result.available += 1;
          else if (status === 2) result.sold += 1;
          else result.unknown += 1;
          return result;
        }, { available: 0, sold: 0, unknown: 0 });
      }
    }
    const capacity = count.available + count.sold + count.unknown;
    if (count.unknown) throw new Error(`Rejected ${venue.shortName} ${layout.name}: unknown seat state`);
    const listPricePaise = prices.get(item.name);
    if (!Number.isSafeInteger(listPricePaise) || listPricePaise <= 0 || listPricePaise > 100_000) throw new Error(`Rejected ${venue.shortName} ${layout.name}: no verified ticket price was available`);
    return { name: layout.name, listPricePaise, capacity, available: count.available, sold: count.sold, unknown: 0 };
  });
  return calculateCollection(categories);
}

export function parseDistrictSeatCategories(labels, show) {
  const venue = venueForCode(show.venue_code || show.venueCode);
  if (venue?.venueCode !== "SCM") throw new Error("District seat parsing is approved only for Sai Chitra");
  const prices = new Map(jsonValue(show.advertised_categories_json, show.categories || [])
    .map((item) => [normalizedName(item.name), Number(item.listPricePaise || 0)]));
  const observed = new Map();
  for (const rawLabel of labels || []) {
    const label = String(rawLabel || "").trim();
    const status = /^available\s+seat/i.test(label)
      ? "available"
      : (/^unavailable\s+seat/i.test(label) ? "sold" : null);
    const classMatch = label.match(/class\s+([^,]+)/i);
    if (!status || !classMatch) continue;
    const name = normalizedName(classMatch[1]);
    const priceMatch = label.match(/price\s+(\d+(?:\.\d+)?)/i);
    const current = observed.get(name) || {
      name,
      available: 0,
      sold: 0,
      unknown: 0,
      listPricePaise: prices.get(name) || 0
    };
    current[status] += 1;
    if (priceMatch) current.listPricePaise = Math.round(Number(priceMatch[1]) * 100);
    observed.set(name, current);
  }
  const expected = new Map(venue.layoutCategories.map((item) => [normalizedName(item.name), item]));
  if (observed.size !== expected.size) {
    throw new Error(`Rejected ${venue.shortName} layout: expected ${expected.size} categories, received ${observed.size}`);
  }
  const categories = venue.layoutCategories.map((layout) => {
    const category = observed.get(normalizedName(layout.name));
    if (!category) throw new Error(`Rejected ${venue.shortName} layout: missing ${layout.name}`);
    const capacity = category.available + category.sold;
    if (capacity !== Number(layout.capacity)) {
      throw new Error(`Rejected ${venue.shortName} ${layout.name}: counted ${capacity} real seats, expected ${layout.capacity}`);
    }
    const expectedPrice = prices.get(normalizedName(layout.name));
    if (!Number.isSafeInteger(category.listPricePaise) || category.listPricePaise <= 0 ||
        (expectedPrice && category.listPricePaise !== expectedPrice)) {
      throw new Error(`Rejected ${venue.shortName} ${layout.name}: live price did not match discovery`);
    }
    return { ...category, name: layout.name, capacity };
  });
  return calculateCollection(categories);
}

function isExplicitSoldOutMessage(message) {
  const normalized = String(message || "").trim().toLowerCase().replace(/\s+/g, " ");
  return /\b(?:seats?|show)\s+(?:are|is)\s+sold\s*out\b/.test(normalized)
    || /\bno\s+(?:available\s+)?seats?\b/.test(normalized)
    || /\bno\s+seats?\s+(?:are\s+)?available\b/.test(normalized);
}

function fullCapacityCapture(show, providerMessage) {
  if (!isExplicitSoldOutMessage(providerMessage)) return null;
  const venue = venueForCode(show.venue_code || show.venueCode);
  if (!venue || !isBmsTestingVenue(venue.venueCode)) {
    throw new BmsUpstreamError("Venue is not approved for BMS testing", {
      code: "venue_not_approved",
      stage: "sold_out_validation"
    });
  }
  const prices = new Map(jsonValue(show.advertised_categories_json, [])
    .map((item) => [normalizedName(item.name), Number(item.listPricePaise || 0)]));
  const categories = venue.layoutCategories.map((layout) => {
    const listPricePaise = prices.get(normalizedName(layout.name));
    if (!Number.isSafeInteger(listPricePaise) || listPricePaise <= 0 || listPricePaise > 100_000) {
      throw new BmsUpstreamError(`Rejected ${venue.shortName} ${layout.name}: no verified ticket price was available`, {
        code: "price_mismatch",
        stage: "sold_out_validation"
      });
    }
    return {
      name: layout.name,
      listPricePaise,
      capacity: layout.capacity,
      available: 0,
      sold: layout.capacity,
      unknown: 0
    };
  });
  return { ...calculateCollection(categories), captureEvidence: "provider_sold_out" };
}

export async function fetchBmsTestingCapture(show, options = {}) {
  const body = new FormData();
  for (const [name, value] of Object.entries({
    strAppCode: "WEB", lngTransactionIdentifier: "0", strCommand: "GETSEATLAYOUT",
    strVenueCode: show.venue_code, strParam1: show.session_id, strParam2: "WEB",
    strParam3: "", strParam4: "", strParam5: "Y", strParam6: "N", strParam7: "N",
    strParam8: "", strParam9: "", strParam10: "", strFormat: "json"
  })) body.append(name, value);
  const response = await (options.fetchImpl || fetch)(BMS_SEAT_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      origin: "https://in.bookmyshow.com",
      referer: "https://in.bookmyshow.com/",
      "x-app-code": "WEB",
      "x-bms-id": `1.${Date.now()}.${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
    },
    signal: options.signal || AbortSignal.timeout(10_000),
    body
  });
  if (!response.ok) throw new BmsUpstreamError(`BMS seat API returned HTTP ${response.status}`, {
    status: response.status,
    code: response.status === 429 ? "rate_limited" : response.status === 403 ? "forbidden" : "http_error",
    retryAfterMs: retryAfterMs(response)
  });
  const result = (await response.json())?.BookMyShow;
  if (String(result?.blnSuccess).toLowerCase() !== "true" || !result?.strData) {
    const full = fullCapacityCapture(show, result?.strException);
    if (full) return full;
    throw new BmsUpstreamError(result?.strException || "BMS returned no seat data", { code: "no_seat_data" });
  }
  const plaintext = await decryptBmsSeatLayout(result.strData, options.keyText, options.cryptoImpl || crypto);
  return parseBmsSeatCategories(plaintext, show);
}

function assertBrowserPage(html, status, stage, provider = "BMS") {
  if (status === 403 || status === 429) {
    throw new BmsUpstreamError(`${provider} blocked ${stage} in Chromium with HTTP ${status}`, {
      status,
      code: status === 403 ? "forbidden" : "rate_limited",
      stage
    });
  }
  if (!status || status >= 400) {
    throw new BmsUpstreamError(`${provider} ${stage} returned HTTP ${status || "unknown"} in Chromium`, {
      status: status || null,
      code: "http_error",
      stage
    });
  }
  const lower = String(html || "").toLowerCase();
  if (["cf-chl-", "just a moment", "attention required", "access denied"].some((marker) => lower.includes(marker))) {
    throw new BmsUpstreamError(`${provider} presented a browser verification page during ${stage}`, {
      status: 403,
      code: "browser_verification_required",
      stage
    });
  }
}

async function launchBmsBrowser(env) {
  try {
    return await puppeteer.launch(env.BROWSER, { keep_alive: 120_000 });
  } catch (error) {
    throw new BmsUpstreamError(`Cloudflare could not start the BMS browser: ${error.message || error}`, {
      code: "browser_launch_failed",
      stage: "browser_launch"
    });
  }
}

async function gotoInBrowser(page, url, stage) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const html = await page.content();
  assertBrowserPage(html, response?.status(), stage);
  return html;
}

async function withBmsBrowser(env, task, sharedBrowser = null) {
  if (!env.BROWSER) throw new BmsUpstreamError("Cloudflare Browser Rendering is not configured", {
    code: "browser_not_configured",
    stage: "browser_configuration"
  });
  const browser = sharedBrowser || await launchBmsBrowser(env);
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ "accept-language": "en-IN,en;q=0.9" });
    await gotoInBrowser(page, BMS_HOME, "Madanapalle browser warm-up");
    return await task(page);
  } catch (error) {
    if (error instanceof BmsUpstreamError) throw error;
    throw new BmsUpstreamError(`Chromium could not complete the BMS request: ${error.message || error}`, {
      code: "browser_request_failed",
      stage: "browser_request"
    });
  } finally {
    if (page) await page.close().catch(() => {});
    if (!sharedBrowser) await browser.close();
  }
}

async function withDistrictBrowser(env, task, sharedBrowser = null) {
  if (!env.BROWSER) throw new BmsUpstreamError("Cloudflare Browser Rendering is not configured", {
    code: "browser_not_configured",
    stage: "browser_configuration"
  });
  const browser = sharedBrowser || await launchBmsBrowser(env);
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ "accept-language": "en-IN,en;q=0.9" });
    return await task(page);
  } catch (error) {
    if (error instanceof BmsUpstreamError) throw error;
    throw new BmsUpstreamError(`Chromium could not complete the District request: ${error.message || error}`, {
      code: "browser_request_failed",
      stage: "district_browser_request"
    });
  } finally {
    if (page) await page.close().catch(() => {});
    if (!sharedBrowser) await browser.close();
  }
}

async function fetchBmsTheatreScheduleBrowser(env, venue, showDate, options = {}) {
  const url = `${BMS_BASE}/cinemas/mdnp/${venue.slug}/buytickets/${venue.venueCode}/${dateCode(showDate)}`;
  return withBmsBrowser(env, async (page) => {
    const html = await gotoInBrowser(page, url, `${venue.shortName} schedule request`);
    return parseBmsTheatreSchedule(html, venue, showDate, options.now || new Date());
  }, options.browser);
}

async function fetchDistrictTheatreScheduleBrowser(env, venue, showDate, options = {}) {
  const url = new URL(venue.districtUrl);
  url.searchParams.set("fromdate", showDate);
  return withDistrictBrowser(env, async (page) => {
    const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
    const html = await page.content();
    assertBrowserPage(html, response?.status(), `${venue.shortName} schedule request`, "District");
    return parseDistrictTheatreSchedule(html, venue, showDate, options.now || new Date());
  }, options.browser);
}

async function fetchBmsTestingCaptureBrowser(env, show, options = {}) {
  const venue = venueForCode(show.venue_code || show.venueCode);
  const pageUrl = `${BMS_BASE}/cinemas/mdnp/${venue.slug}/buytickets/${venue.venueCode}/${show.show_date_code || dateCode(show.show_date)}`;
  return withBmsBrowser(env, async (page) => {
    const html = await gotoInBrowser(page, pageUrl, "show warm-up request");
    if (!html.includes("window.__INITIAL_STATE__")) {
      throw new BmsUpstreamError("BMS show warm-up page did not expose schedule state", {
        code: "verification_or_schema_changed",
        stage: "show_warmup"
      });
    }
    const fields = {
      strAppCode: "WEB", lngTransactionIdentifier: "0", strCommand: "GETSEATLAYOUT",
      strVenueCode: show.venue_code, strParam1: show.session_id, strParam2: "WEB",
      strParam3: "", strParam4: "", strParam5: "Y", strParam6: "N", strParam7: "N",
      strParam8: "", strParam9: "", strParam10: "", strFormat: "json"
    };
    const requestId = `1.${Date.now()}.${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const cookies = await page.cookies(BMS_BASE, BMS_SEAT_ENDPOINT);
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const body = new FormData();
    for (const [name, value] of Object.entries(fields)) body.append(name, value);
    const seatResponse = await (options.fetchImpl || fetch)(BMS_SEAT_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
        origin: BMS_BASE,
        referer: pageUrl,
        "user-agent": userAgent,
        "x-app-code": "WEB",
        "x-bms-id": requestId
      },
      body,
      signal: AbortSignal.timeout(15_000)
    });
    const browserResult = { status: seatResponse.status, text: await seatResponse.text() };
    assertBrowserPage(browserResult.text, browserResult.status, "seat-layout request");
    let response;
    try { response = JSON.parse(browserResult.text); }
    catch {
      throw new BmsUpstreamError("BMS seat response was not JSON", {
        code: "schema_changed",
        stage: "seat_layout_response"
      });
    }
    const result = response?.BookMyShow;
    if (String(result?.blnSuccess).toLowerCase() !== "true" || !result?.strData) {
      const full = fullCapacityCapture(show, result?.strException);
      if (full) return full;
      throw new BmsUpstreamError(result?.strException || "BMS returned no seat data", {
        code: "no_seat_data",
        stage: "seat_layout_response"
      });
    }
    let plaintext;
    try {
      plaintext = await decryptBmsSeatLayout(result.strData, options.keyText, options.cryptoImpl || crypto);
    } catch (error) {
      throw new BmsUpstreamError(`BMS seat layout could not be decoded: ${error.message || error}`, {
        code: "seat_layout_decode_failed",
        stage: "seat_layout_decode"
      });
    }
    try {
      return parseBmsSeatCategories(plaintext, show);
    } catch (error) {
      throw new BmsUpstreamError(error.message || "BMS seat layout validation failed", {
        code: "seat_layout_validation_failed",
        stage: "seat_layout_validation"
      });
    }
  }, options.browser);
}

async function fetchDistrictTestingCaptureBrowser(env, show, options = {}) {
  const venue = venueForCode(show.venue_code || show.venueCode);
  if (venue?.venueCode !== "SCM") {
    throw new BmsUpstreamError("District capture is approved only for Sai Chitra", {
      code: "venue_not_approved",
      stage: "district_capture"
    });
  }
  let url;
  try { url = new URL(String(show.provider_url || show.providerUrl || "")); }
  catch {
    throw new BmsUpstreamError("Sai Chitra testing show has no exact District seat route", {
      code: "session_route_missing",
      stage: "district_capture"
    });
  }
  const encodedSession = String(url.searchParams.get("encsessionid") || "");
  const districtHost = url.hostname === "district.in" || url.hostname === "www.district.in" || url.hostname.endsWith(".district.in");
  if (url.protocol !== "https:" || !districtHost || !url.pathname.includes("/movies/seat-layout/") ||
      !encodedSession.startsWith(`${venue.cinemaId}-${show.session_id}-`)) {
    throw new BmsUpstreamError("Sai Chitra testing show did not retain its exact District session route", {
      code: "session_route_mismatch",
      stage: "district_capture"
    });
  }
  return withDistrictBrowser(env, async (page) => {
    const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
    const html = await page.content();
    assertBrowserPage(html, response?.status(), "seat-layout request", "District");
    const expectedCapacity = venue.layoutCategories.reduce((sum, item) => sum + Number(item.capacity), 0);
    let labels = [];
    const started = Date.now();
    while (Date.now() - started < 12_000) {
      labels = await page.evaluate(() => Array.from(
        document.querySelectorAll('[aria-label^="available"], [aria-label^="unavailable"]')
      ).map((seat) => seat.getAttribute("aria-label")).filter(Boolean));
      if (labels.length === expectedCapacity) break;
      await sleep(250);
    }
    if (!labels.length) {
      const providerMessage = await page.evaluate(() => document.body?.innerText || "");
      const full = fullCapacityCapture(show, providerMessage);
      if (full) return full;
      throw new BmsUpstreamError("District live seat map did not render before the capture deadline", {
        code: "seat_layout_not_ready",
        stage: "district_seat_layout"
      });
    }
    try { return parseDistrictSeatCategories(labels, show); }
    catch (error) {
      throw new BmsUpstreamError(error.message || "District seat layout validation failed", {
        code: "seat_layout_validation_failed",
        stage: "district_seat_layout"
      });
    }
  }, options.browser);
}

function extractJson(text, marker) {
  const start = text.indexOf("{", marker);
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index >= 0 && index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

export function parseBmsTheatreSchedule(html, venue, showDate, now = new Date()) {
  const marker = String(html || "").indexOf("window.__INITIAL_STATE__");
  const encoded = marker >= 0 ? extractJson(String(html), marker) : null;
  if (!encoded) throw new BmsUpstreamError("BMS theatre page did not expose schedule data", { code: "verification_or_schema_changed" });
  let state;
  try { state = JSON.parse(encoded); } catch { throw new BmsUpstreamError("BMS theatre schedule was not valid JSON", { code: "schema_changed" }); }
  const code = dateCode(showDate);
  const queries = state?.venueShowtimesFunctionalApi?.queries || {};
  const query = queries[`getShowtimesByVenue-${venue.venueCode}-${code}`] || Object.entries(queries).find(([key]) => key.includes(venue.venueCode) && key.includes(code))?.[1];
  const details = query?.data?.showDetailsTransformed;
  if (!details) throw new BmsUpstreamError("BMS theatre page did not include the requested schedule", { code: "schedule_missing" });
  const discoveredAt = now.toISOString();
  const result = [];
  for (const event of details.Event || []) for (const child of event.ChildEvents || []) for (const show of child.ShowTimes || []) {
    const eventCode = String(child.EventCode || ""), sessionId = String(show.SessionId || "");
    if (!eventCode || !sessionId) continue;
    const startAt = codeToDate(show.ShowDateTime).toISOString();
    const cutoffAt = codeToDate(show.CutOffDateTime).toISOString();
    result.push({
      naturalKey: [venue.venueCode, code, show.ShowTimeCode, sessionId, eventCode].join(":"),
      venueCode: venue.venueCode, venueName: venue.name, showDate, showDateCode: code,
      showTimeCode: String(show.ShowTimeCode || ""), showTimeLabel: String(show.ShowTime || ""),
      startAt, cutoffAt, captureAt: addMs(startAt, venue.captureStartAfterShowMinutes * 60_000),
      finalCaptureAt: addMs(cutoffAt, -60_000), sessionId, eventCode,
      movieTitle: String(event.EventTitle || child.EventName || "Untitled movie"),
      movieVariant: String(child.EventName || event.EventTitle || ""),
      language: String(child.EventLanguage || child.EventLang || ""), format: String(child.EventDimension || ""),
      screenName: String(show.ScreenName || ""), discoveredAt,
      categories: (show.Categories || []).map((category) => ({
        name: category.PriceDesc || "Category", priceCode: category.PriceCode || "",
        listPricePaise: Math.round(Number(category.CurPrice || 0) * 100), availabilityStatus: String(category.AvailStatus ?? "")
      }))
    });
  }
  return result;
}

function districtNextData(html) {
  const match = String(html || "").match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) {
    throw new BmsUpstreamError("District theatre page did not expose schedule data", {
      code: "verification_or_schema_changed",
      stage: "district_schedule"
    });
  }
  try { return JSON.parse(match[1]); }
  catch {
    throw new BmsUpstreamError("District theatre schedule was not valid JSON", {
      code: "schema_changed",
      stage: "district_schedule"
    });
  }
}

function districtCinemaPayload(state, venue, showDate) {
  const sources = [
    state?.props?.pageProps?.initialState?.movies?.cinemaSessions,
    state?.props?.pageProps?.data?.serverState?.cinemaSessions,
    state?.props?.pageProps?.initialState?.cinemaSessions
  ];
  const key = `${venue.cinemaId}${showDate}`;
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const exact = source[key];
    if (exact) return exact;
    const matching = Object.values(source).find((item) =>
      String(item?.meta?.cinema?.id || "") === String(venue.cinemaId) &&
      (item?.pageData?.sessions || item?.arrangedSessions?.flatMap((group) => group.sessions || []) || [])
        .some((session) => String(session.showDate || "") === showDate)
    );
    if (matching) return matching;
  }
  throw new BmsUpstreamError(`District did not include the ${venue.shortName} schedule for ${showDate}`, {
    code: "schedule_missing",
    stage: "district_schedule"
  });
}

function districtUtcDate(value, field) {
  const text = String(value || "").trim();
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}${text.length === 16 ? ":00" : ""}Z`;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) {
    throw new BmsUpstreamError(`District returned an invalid ${field}`, {
      code: "schema_changed",
      stage: "district_schedule"
    });
  }
  return date;
}

function districtShowTimeCode(session, startAt) {
  const local = String(session.showTimeISO || session.showTimeLocal || "").match(/T(\d{2}):(\d{2})/);
  if (local) return `${local[1]}${local[2]}`;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(startAt);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}${values.minute}`;
}

function districtSeatLayoutUrl(venue, session, metadata, showDate) {
  const sessionId = String(session.sid || "").trim();
  const formatId = String(session.fid || session.entityDataCode || metadata?.formatGroupIds?.[0] || "").trim().toLowerCase();
  const eventCode = String(session.mid || "").trim().toLowerCase();
  const encodedSession = String(session.encSessionId || [venue.cinemaId, sessionId, eventCode, formatId]
    .filter(Boolean).join("-"));
  if (!sessionId || !formatId || !encodedSession.startsWith(`${venue.cinemaId}-${sessionId}-`)) {
    throw new BmsUpstreamError("District did not expose an exact Sai Chitra seat-layout route", {
      code: "session_route_missing",
      stage: "district_schedule"
    });
  }
  const url = new URL(`/movies/seat-layout/${encodeURIComponent(formatId)}`, DISTRICT_BASE);
  url.searchParams.set("encsessionid", encodedSession);
  url.searchParams.set("fromdate", showDate);
  url.searchParams.set("freeseating", String(Boolean(session.freeSeating || session.freeseating)));
  url.searchParams.set("fromsessions", "true");
  url.searchParams.set("type", "CINEMAS");
  if (session.contentId || metadata?.contentId) url.searchParams.set("contentid", String(session.contentId || metadata.contentId));
  return url.toString();
}

export function parseDistrictTheatreSchedule(html, venue, showDate, now = new Date()) {
  if (venue?.venueCode !== "SCM" || !venue.cinemaId) {
    throw new BmsUpstreamError("District server testing is approved only for Sai Chitra", {
      code: "venue_not_approved",
      stage: "district_schedule"
    });
  }
  const state = districtNextData(html);
  const payload = districtCinemaPayload(state, venue, showDate);
  const arranged = payload.pageData?.arrangedSessions?.length
    ? payload.pageData.arrangedSessions
    : payload.arrangedSessions || [];
  const pageSessions = payload.pageData?.sessions || [];
  const groups = arranged.length ? arranged : [{ data: payload.meta?.movies?.[0] || {}, sessions: pageSessions }];
  const discoveredAt = now.toISOString();
  const shows = [];
  for (const group of groups) {
    const metadata = group.data || {};
    for (const session of group.sessions || []) {
      if (String(session.showDate || "") !== showDate) continue;
      const sessionId = String(session.sid || "").trim();
      const eventCode = String(session.mid || metadata.id || "").trim();
      if (!sessionId || !eventCode) continue;
      const startAt = session.showTimeISO
        ? new Date(session.showTimeISO)
        : districtUtcDate(session.showTime, "show time");
      const cutoffAt = districtUtcDate(session.closeTime, "cutoff time");
      if (!Number.isFinite(startAt.getTime()) || cutoffAt <= startAt) {
        throw new BmsUpstreamError("District returned unsafe Sai Chitra capture timing", {
          code: "schema_changed",
          stage: "district_schedule"
        });
      }
      const showTimeCode = districtShowTimeCode(session, startAt);
      const finalCaptureAt = addMs(cutoffAt.toISOString(), -60_000);
      const categories = (session.areas || []).map((area) => ({
        name: String(area.label || "Category"),
        priceCode: String(area.code || ""),
        listPricePaise: Math.round(Number(area.price || 0) * 100),
        availabilityStatus: String(area.seatStatus || area.statusColor || "")
      }));
      if (!categories.length || categories.some((category) => !category.listPricePaise)) {
        throw new BmsUpstreamError("District did not expose every Sai Chitra class price", {
          code: "schema_changed",
          stage: "district_schedule"
        });
      }
      shows.push({
        naturalKey: [venue.venueCode, dateCode(showDate), showTimeCode, sessionId, eventCode].join(":"),
        venueCode: venue.venueCode,
        venueName: venue.name,
        showDate,
        showDateCode: dateCode(showDate),
        showTimeCode,
        showTimeLabel: String(session.showTimeText || ""),
        startAt: startAt.toISOString(),
        cutoffAt: cutoffAt.toISOString(),
        captureAt: finalCaptureAt,
        finalCaptureAt,
        sessionId,
        eventCode,
        movieTitle: String(group.entityName || metadata.name || metadata.label || "Untitled movie"),
        movieVariant: String(metadata.name || metadata.label || group.entityName || ""),
        language: String(session.lang || metadata.lang || metadata.languages || ""),
        format: String(session.scrnFmt || metadata.scrnFmt || ""),
        screenName: String(session.audi || ""),
        provider: "district",
        providerUrl: districtSeatLayoutUrl(venue, session, metadata, showDate),
        discoveredAt,
        categories
      });
    }
  }
  if (!shows.length) {
    throw new BmsUpstreamError(`District found no Sai Chitra shows for ${showDate}`, {
      code: "schedule_missing",
      stage: "district_schedule"
    });
  }
  return shows;
}

export async function fetchBmsTheatreSchedule(venue, showDate, options = {}) {
  const url = `https://in.bookmyshow.com/cinemas/mdnp/${venue.slug}/buytickets/${venue.venueCode}/${dateCode(showDate)}`;
  const response = await (options.fetchImpl || fetch)(url, {
    headers: { accept: "text/html", "user-agent": "MPLTalkies-BMSTesting/1.0" },
    signal: options.signal || AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new BmsUpstreamError(`BMS theatre page returned HTTP ${response.status}`, {
    status: response.status,
    code: response.status === 429 ? "rate_limited" : response.status === 403 ? "forbidden" : "http_error",
    retryAfterMs: retryAfterMs(response)
  });
  return parseBmsTheatreSchedule(await response.text(), venue, showDate, options.now || new Date());
}

export function normalizeServiceShows(payload, venue, showDate, now) {
  if (String(payload?.venueCode || "").toUpperCase() !== venue.venueCode) {
    throw new BmsUpstreamError("Capture service returned a different theatre", { code: "service_schema_changed" });
  }
  if (String(payload?.showDate || "") !== showDate || !Array.isArray(payload?.shows)) {
    throw new BmsUpstreamError("Capture service returned an invalid schedule", { code: "service_schema_changed" });
  }
  return payload.shows.map((show) => {
    const sessionId = String(show.sessionId || "").trim();
    const eventCode = String(show.eventCode || "").trim();
    const showTimeCode = String(show.showTimeCode || "").trim();
    const startAt = new Date(show.startAt);
    const cutoffAt = new Date(show.cutoffAt);
    const categories = Array.isArray(show.categories) ? show.categories.map((category) => ({
      name: String(category.name || "Category"),
      priceCode: String(category.priceCode || ""),
      listPricePaise: Number(category.listPricePaise || 0),
      availabilityStatus: String(category.availabilityStatus ?? "")
    })) : [];
    if (!sessionId || !eventCode || !showTimeCode || !Number.isFinite(startAt.getTime()) || !Number.isFinite(cutoffAt.getTime())) {
      throw new BmsUpstreamError("Capture service returned an incomplete show", { code: "service_schema_changed" });
    }
    if (cutoffAt <= startAt || !categories.length || categories.some((category) => !Number.isSafeInteger(category.listPricePaise) || category.listPricePaise <= 0)) {
      throw new BmsUpstreamError("Capture service returned unsafe show metadata", { code: "service_schema_changed" });
    }
    const finalCaptureAt = addMs(cutoffAt.toISOString(), -60_000);
    return {
      naturalKey: [venue.venueCode, dateCode(showDate), showTimeCode, sessionId, eventCode].join(":"),
      venueCode: venue.venueCode,
      venueName: venue.name,
      showDate,
      showDateCode: dateCode(showDate),
      showTimeCode,
      showTimeLabel: String(show.showTimeLabel || ""),
      startAt: startAt.toISOString(),
      cutoffAt: cutoffAt.toISOString(),
      captureAt: finalCaptureAt,
      finalCaptureAt,
      sessionId,
      eventCode,
      movieTitle: String(show.movieTitle || "Untitled movie"),
      movieVariant: String(show.movieVariant || ""),
      language: String(show.language || ""),
      format: String(show.format || ""),
      screenName: String(show.screenName || ""),
      discoveredAt: now,
      categories
    };
  });
}

export function validateServiceCapture(payload, show) {
  if (String(payload?.venueCode || "").toUpperCase() !== show.venue_code || String(payload?.sessionId || "") !== show.session_id) {
    throw new BmsUpstreamError("Capture service response did not match the requested testing show", { code: "service_schema_changed" });
  }
  const venue = venueForCode(show.venue_code);
  const expected = new Map(venue.layoutCategories.map((item) => [normalizedName(item.name), item]));
  const prices = new Map(jsonValue(show.advertised_categories_json, []).map((item) => [normalizedName(item.name), Number(item.listPricePaise || 0)]));
  if (!Array.isArray(payload?.categories) || payload.categories.length !== expected.size) {
    throw new BmsUpstreamError(`Rejected ${venue.shortName} layout: expected ${expected.size} categories`, { code: "layout_mismatch" });
  }
  const categories = payload.categories.map((category) => {
    const name = normalizedName(category.name);
    const layout = expected.get(name);
    const capacity = Number(category.capacity);
    const available = Number(category.available);
    const unavailable = Number(category.unavailable);
    const unknown = Number(category.unknown || 0);
    const listPricePaise = Number(category.listPricePaise || 0);
    if (!layout || ![capacity, available, unavailable, unknown, listPricePaise].every(Number.isSafeInteger)) {
      throw new BmsUpstreamError(`Rejected ${venue.shortName} layout: invalid category data`, { code: "layout_mismatch" });
    }
    const allowedCapacities = new Set([Number(layout.capacity), Number(layout.physicalCapacity || layout.capacity)]);
    if (!allowedCapacities.has(capacity) || available + unavailable + unknown !== capacity || unknown !== 0) {
      throw new BmsUpstreamError(`Rejected ${venue.shortName} ${layout.name}: expected ${[...allowedCapacities].join(" or ")} known seats`, { code: "layout_mismatch" });
    }
    if (prices.get(name) !== listPricePaise) {
      throw new BmsUpstreamError(`Rejected ${venue.shortName} ${layout.name}: ticket price changed during capture`, { code: "price_mismatch" });
    }
    return { name: layout.name, capacity, available, sold: unavailable, unknown, listPricePaise };
  });
  return calculateCollection(categories);
}

async function discoverVenueFromService(env, venueCode, showDate, now, options = {}) {
  const venue = venueForCode(venueCode);
  if (internalCaptureService(env)) {
    if (venue.venueCode === "SCM") {
      if (!env.BROWSER) {
        throw new BmsUpstreamError("Sai Chitra District testing requires Browser Rendering", {
          code: "browser_not_configured",
          stage: "district_schedule"
        });
      }
      return fetchDistrictTheatreScheduleBrowser(env, venue, showDate, { ...options, now: new Date(now) });
    }
    if (env.BROWSER) return fetchBmsTheatreScheduleBrowser(env, venue, showDate, { ...options, now: new Date(now) });
    return fetchBmsTheatreSchedule(venue, showDate, { ...options, now: new Date(now) });
  }
  if (venue.venueCode !== "RTDM") {
    throw new BmsUpstreamError("The external legacy capture service supports Ravi only", { code: "service_venue_unsupported" });
  }
  const payload = await callCaptureService(env, "v1/ravi/discover", {
    venueCode: venue.venueCode,
    venueSlug: venue.slug,
    showDate
  }, options);
  return normalizeServiceShows(payload, venue, showDate, now);
}

async function captureVenueFromService(env, show, options = {}) {
  const venue = venueForCode(show.venue_code);
  if (internalCaptureService(env)) {
    if (venue.venueCode === "SCM") {
      if (!env.BROWSER) {
        throw new BmsUpstreamError("Sai Chitra District testing requires Browser Rendering", {
          code: "browser_not_configured",
          stage: "district_capture"
        });
      }
      return {
        result: await fetchDistrictTestingCaptureBrowser(env, show, options),
        capturedAt: new Date().toISOString()
      };
    }
    const captureOptions = { ...options, keyText: env.BMS_LAYOUT_KEY };
    const result = env.BROWSER
      ? await fetchBmsTestingCaptureBrowser(env, show, captureOptions)
      : await fetchBmsTestingCapture(show, captureOptions);
    return { result, capturedAt: new Date().toISOString() };
  }
  if (venue.venueCode !== "RTDM") {
    throw new BmsUpstreamError("The external legacy capture service supports Ravi only", { code: "service_venue_unsupported" });
  }
  const payload = await callCaptureService(env, "v1/ravi/capture", {
    venueCode: venue.venueCode,
    venueSlug: venue.slug,
    showDate: show.show_date,
    showDateCode: show.show_date_code,
    sessionId: show.session_id,
    eventCode: show.event_code,
    movieTitle: show.movie_title,
    categories: jsonValue(show.advertised_categories_json, [])
  }, options);
  return { result: validateServiceCapture(payload, show), capturedAt: payload.capturedAt };
}

async function ensureStates(db, showDate, now) {
  await db.batch(BMS_TESTING_VENUE_CODES.map((code) => db.prepare(
    "INSERT OR IGNORE INTO bms_testing_discovery_state (venue_code, show_date, next_attempt_at, updated_at) VALUES (?, ?, ?, ?)"
  ).bind(code, showDate, now, now)));
}

async function claimDiscovery(db, showDate, now) {
  const row = await db.prepare(`SELECT * FROM bms_testing_discovery_state WHERE show_date=? AND next_attempt_at<=?
    AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY next_attempt_at, venue_code LIMIT 1`).bind(showDate, now, now).first();
  if (!row) return null;
  const changed = await db.prepare(`UPDATE bms_testing_discovery_state SET lease_expires_at=?, last_started_at=?,
    last_status='running', updated_at=? WHERE venue_code=? AND show_date=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)`)
    .bind(addMs(now, 120_000), now, now, row.venue_code, showDate, now).run();
  return Number(changed.meta?.changes || 0) ? row : null;
}

async function saveDiscovery(db, venue, showDate, shows, now) {
  if (!shows.length) return 0;
  await db.prepare("UPDATE bms_testing_shows SET is_current=0, updated_at=? WHERE venue_code=? AND show_date=?")
    .bind(now, venue.venueCode, showDate).run();
  await db.batch(shows.map((show) => db.prepare(`INSERT INTO bms_testing_shows
    (natural_key, venue_code, venue_name, show_date, show_date_code, show_time_code, show_time_label,
     start_at, cutoff_at, capture_at, final_capture_at, session_id, event_code, movie_title, movie_variant,
     language, format, screen_name, advertised_categories_json, provider, provider_url,
     is_current, discovered_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(natural_key) DO UPDATE SET show_time_label=excluded.show_time_label, start_at=excluded.start_at,
    cutoff_at=excluded.cutoff_at, capture_at=excluded.capture_at, final_capture_at=excluded.final_capture_at,
    movie_title=excluded.movie_title, movie_variant=excluded.movie_variant, language=excluded.language,
    format=excluded.format, screen_name=excluded.screen_name, advertised_categories_json=excluded.advertised_categories_json,
    provider=excluded.provider, provider_url=excluded.provider_url,
    is_current=1, last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at`).bind(
      show.naturalKey, show.venueCode, show.venueName, show.showDate, show.showDateCode, show.showTimeCode,
      show.showTimeLabel, show.startAt, show.cutoffAt, show.captureAt, show.finalCaptureAt, show.sessionId,
      show.eventCode, show.movieTitle, show.movieVariant, show.language, show.format, show.screenName,
      JSON.stringify(show.categories), show.provider || "bookmyshow", show.providerUrl || null,
      show.discoveredAt, now, now, now
    )));
  const rows = await db.prepare("SELECT id, capture_at, final_capture_at, cutoff_at FROM bms_testing_shows WHERE venue_code=? AND show_date=? AND is_current=1")
    .bind(venue.venueCode, showDate).all();
  const jobs = [];
  for (const show of rows.results || []) {
    jobs.push(db.prepare(`INSERT INTO bms_testing_capture_jobs
      (testing_show_id, phase, due_at, deadline_at, next_attempt_at, created_at, updated_at)
      VALUES (?, 'final', ?, ?, ?, ?, ?) ON CONFLICT(testing_show_id, phase) DO UPDATE SET
      due_at=excluded.due_at, deadline_at=excluded.deadline_at,
      next_attempt_at=CASE WHEN status='pending' THEN excluded.next_attempt_at ELSE next_attempt_at END,
      updated_at=excluded.updated_at`).bind(show.id, show.final_capture_at, show.cutoff_at, show.final_capture_at, now, now));
  }
  await db.prepare(`UPDATE bms_testing_capture_jobs SET status='failed', last_error='Server testing captures final state only', updated_at=?
    WHERE phase='initial' AND status IN ('pending', 'running') AND testing_show_id IN
    (SELECT id FROM bms_testing_shows WHERE venue_code=? AND show_date=?)`).bind(now, venue.venueCode, showDate).run();
  if (jobs.length) await db.batch(jobs);
  return rows.results?.length || 0;
}

async function logRun(db, run) {
  await db.prepare(`INSERT INTO bms_testing_runs
    (run_type, venue_code, show_date, testing_show_id, phase, status, attempt, started_at, finished_at,
     http_status, error_code, error, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(run.type, run.venue || null, run.date || null, run.showId || null, run.phase || null,
      run.status, run.attempt || 1, run.started, run.finished, run.httpStatus || null,
      run.errorCode || null, run.error || null, JSON.stringify(run.details || {})).run();
}

async function discoverOne(env, showDate, now, options) {
  const state = await claimDiscovery(env.DB, showDate, now);
  if (!state) return null;
  const venue = venueForCode(state.venue_code);
  const started = new Date().toISOString();
  try {
    const shows = await discoverVenueFromService(env, venue.venueCode, showDate, now, options);
    const count = await saveDiscovery(env.DB, venue, showDate, shows, now);
    const finished = new Date().toISOString();
    await env.DB.prepare(`UPDATE bms_testing_discovery_state SET lease_expires_at=NULL, last_status='succeeded',
      last_error=NULL, last_finished_at=?, next_attempt_at=?, updated_at=? WHERE venue_code=? AND show_date=?`)
      .bind(finished, addMs(finished, BMS_DISCOVERY_INTERVAL_MS), finished, venue.venueCode, showDate).run();
    await logRun(env.DB, {
      type: "discovery", venue: venue.venueCode, date: showDate, status: "succeeded",
      started, finished,
      details: { shows: count, durationMs: elapsedMs(started, finished), transport: env.BROWSER ? "cloudflare_browser" : "direct_http" }
    });
    return { venueCode: venue.venueCode, status: "succeeded", shows: count };
  } catch (error) {
    const finished = new Date().toISOString();
    const wait = error.status === 429
      ? Math.max(error.retryAfterMs || 0, DISCOVERY_RETRY_MS)
      : error.status === 403 ? 21_600_000 : DISCOVERY_RETRY_MS;
    await env.DB.prepare(`UPDATE bms_testing_discovery_state SET lease_expires_at=NULL, last_status='failed',
      last_error=?, last_finished_at=?, next_attempt_at=?, updated_at=? WHERE venue_code=? AND show_date=?`)
      .bind(error.message, finished, addMs(finished, wait), finished, venue.venueCode, showDate).run();
    await logRun(env.DB, {
      type: "discovery", venue: venue.venueCode, date: showDate, status: "failed",
      started, finished, httpStatus: error.status, errorCode: error.code, error: error.message,
      details: {
        stage: error.stage || "schedule_discovery",
        durationMs: elapsedMs(started, finished),
        nextAttemptAt: addMs(finished, wait),
        transport: env.BROWSER ? "cloudflare_browser" : "direct_http"
      }
    });
    return { venueCode: venue.venueCode, status: "failed", error: error.message };
  }
}

async function claimCapture(db, now, claimThrough = now) {
  // A terminated invocation must not strand a show in `running` forever.
  // Return an expired lease to pending first; the normal deadline check below
  // will either retry it safely or record that its capture window expired.
  await db.prepare(`UPDATE bms_testing_capture_jobs SET status='pending', lease_expires_at=NULL,
    last_error='Previous capture lease expired', updated_at=?
    WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`)
    .bind(now, now).run();
  const expired = await db.prepare(`SELECT jobs.id AS job_id, jobs.phase AS job_phase,
    jobs.attempts AS job_attempts, jobs.due_at AS job_due_at, jobs.deadline_at AS job_deadline_at,
    shows.id AS show_id, shows.venue_code, shows.show_date
    FROM bms_testing_capture_jobs jobs
    JOIN bms_testing_shows shows ON shows.id=jobs.testing_show_id
    WHERE jobs.status='pending' AND jobs.deadline_at<?`).bind(now).all();
  for (const job of expired.results || []) {
    const changed = await db.prepare(`UPDATE bms_testing_capture_jobs SET status='failed',
      lease_expires_at=NULL, last_error='Capture window expired', updated_at=?
      WHERE id=? AND status='pending'`).bind(now, job.job_id).run();
    if (!Number(changed.meta?.changes || 0)) continue;
    await logRun(db, {
      type: "capture", venue: job.venue_code, date: job.show_date, showId: job.show_id,
      phase: job.job_phase, status: "failed", attempt: Number(job.job_attempts || 0) + 1,
      started: now, finished: now, errorCode: "capture_window_expired", error: "Capture window expired",
      details: {
        stage: "scheduler_window",
        durationMs: 0,
        dueDelayMs: Math.max(0, elapsedMs(job.job_due_at, now)),
        dueAt: job.job_due_at,
        deadlineAt: job.job_deadline_at,
        retry: false,
        nextAttemptAt: null
      }
    });
  }
  const job = await db.prepare(`SELECT shows.*, jobs.id AS job_id, jobs.phase AS job_phase,
    jobs.attempts AS job_attempts, jobs.due_at AS job_due_at, jobs.deadline_at AS job_deadline_at FROM bms_testing_capture_jobs jobs
    JOIN bms_testing_shows shows ON shows.id=jobs.testing_show_id
    WHERE jobs.status='pending' AND jobs.next_attempt_at<=? AND jobs.deadline_at>=? AND shows.is_current=1
    ORDER BY CASE jobs.phase WHEN 'final' THEN 0 ELSE 1 END, jobs.due_at,
      CASE shows.venue_code WHEN 'RTDM' THEN 1 WHEN 'ASRM' THEN 2 WHEN 'SKMD' THEN 3 WHEN 'MSDR' THEN 4 WHEN 'SUTD' THEN 5 WHEN 'SCM' THEN 6 ELSE 7 END
    LIMIT 1`).bind(claimThrough, now).first();
  if (!job) return null;
  const changed = await db.prepare("UPDATE bms_testing_capture_jobs SET status='running', lease_expires_at=?, attempts=attempts+1, updated_at=? WHERE id=? AND status='pending'")
    .bind(addMs(now, CAPTURE_LEASE_MS), now, job.job_id).run();
  return Number(changed.meta?.changes || 0) ? job : null;
}

async function runCaptures(env, nowDate, options) {
  const output = [];
  let browser = null;
  try {
    for (let index = 0; index < MAX_CAPTURES_PER_RUN; index += 1) {
      const claimNow = (index ? new Date() : nowDate).toISOString();
      // Only the first claim looks ahead to the next minute. Once a browser is
      // open, consume jobs that are already due (including every theatre that
      // shares this cutoff) without holding Browser Run idle for a future slot.
      const claimThrough = index ? claimNow : bmsCaptureClaimThrough(claimNow);
      const job = await claimCapture(env.DB, claimNow, claimThrough);
      if (!job) break;
      const scheduledWaitMs = bmsCaptureWaitMs(job.job_due_at, new Date());
      if (scheduledWaitMs) await sleep(scheduledWaitMs);
      if (index) await sleep(Number.isFinite(options.captureSpacingMs) ? options.captureSpacingMs : CAPTURE_SPACING_MS);
      const started = new Date().toISOString();
      const attempt = Number(job.job_attempts || 0) + 1;
      try {
        if (!browser && internalCaptureService(env) && env.BROWSER) {
          browser = await launchBmsBrowser(env);
        }
        const serviceCapture = await captureVenueFromService(env, job, { ...options, browser });
        const result = serviceCapture.result;
        const serviceCapturedAt = new Date(serviceCapture.capturedAt);
        const captured = Number.isFinite(serviceCapturedAt.getTime()) ? serviceCapturedAt.toISOString() : new Date().toISOString();
        const snapshotSource = String(job.provider || "bookmyshow") === "district"
          ? (result.captureEvidence === "provider_sold_out" ? "district-server-testing-sold-out" : "district-server-testing")
          : (result.captureEvidence === "provider_sold_out" ? "bookmyshow-server-testing-sold-out" : "bookmyshow-server-testing");
        const snapshot = await env.DB.prepare(`INSERT INTO bms_testing_snapshots
          (testing_show_id, phase, captured_at, source, capacity, available, sold, unknown, collection_paise,
           occupancy_percent, categories_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(testing_show_id, phase) DO UPDATE SET captured_at=excluded.captured_at,
          source=excluded.source, capacity=excluded.capacity, available=excluded.available, sold=excluded.sold, unknown=excluded.unknown,
          collection_paise=excluded.collection_paise, occupancy_percent=excluded.occupancy_percent,
          categories_json=excluded.categories_json RETURNING id`).bind(job.id, job.job_phase, captured,
            snapshotSource,
            result.capacity, result.available, result.sold, result.unknown, result.collectionPaise,
            result.occupancyPercent, JSON.stringify(result.categories), captured).first();
        await env.DB.prepare("UPDATE bms_testing_capture_jobs SET status='succeeded', lease_expires_at=NULL, snapshot_id=?, last_error=NULL, updated_at=? WHERE id=?")
          .bind(snapshot.id, captured, job.job_id).run();
        await logRun(env.DB, {
          type: "capture", venue: job.venue_code, date: job.show_date, showId: job.id,
          phase: job.job_phase, status: "succeeded", attempt, started, finished: captured,
          details: {
            stage: "completed",
            evidence: result.captureEvidence || "seat_layout",
            unavailable: result.sold,
            capacity: result.capacity,
            durationMs: elapsedMs(started, captured),
            dueDelayMs: Math.max(0, elapsedMs(job.job_due_at, started)),
            reservedAt: claimNow,
            scheduledWaitMs,
            dueAt: job.job_due_at,
            deadlineAt: job.job_deadline_at,
            transport: env.BROWSER ? "cloudflare_browser" : "direct_http"
          }
        });
        output.push({ showId: job.id, phase: job.job_phase, status: "succeeded" });
      } catch (error) {
        const finished = new Date().toISOString();
        const wait = error.status === 429 ? Math.max(error.retryAfterMs || 0, RATE_LIMIT_RETRY_MS) : RETRY_MS;
        const next = addMs(finished, wait);
        const retry = attempt < 3 && next <= job.job_deadline_at && error.status !== 403;
        await env.DB.prepare("UPDATE bms_testing_capture_jobs SET status=?, lease_expires_at=NULL, next_attempt_at=?, last_error=?, updated_at=? WHERE id=?")
          .bind(retry ? "pending" : "failed", next, error.message, finished, job.job_id).run();
        await logRun(env.DB, {
          type: "capture", venue: job.venue_code, date: job.show_date, showId: job.id,
          phase: job.job_phase, status: retry ? "retrying" : "failed", attempt,
          started, finished, httpStatus: error.status, errorCode: error.code, error: error.message,
          details: {
            stage: error.stage || "capture_request",
            durationMs: elapsedMs(started, finished),
            dueDelayMs: Math.max(0, elapsedMs(job.job_due_at, started)),
            reservedAt: claimNow,
            scheduledWaitMs,
            dueAt: job.job_due_at,
            deadlineAt: job.job_deadline_at,
            retry,
            nextAttemptAt: retry ? next : null,
            transport: env.BROWSER ? "cloudflare_browser" : "direct_http"
          }
        });
        output.push({ showId: job.id, phase: job.job_phase, status: retry ? "retrying" : "failed" });
        if (error.status === 429) break;
      }
    }
  } finally {
    if (browser) await browser.close();
  }
  return output;
}

export async function runBmsTestingScheduler(env, options = {}) {
  if (!bmsTestingEnabled(env)) return { enabled: false, discovery: null, captures: [] };
  const now = options.now || new Date();
  const showDate = indiaDate(now);
  await ensureStates(env.DB, showDate, now.toISOString());
  const captures = await runCaptures(env, now, options);
  // A due final capture always owns the browser invocation. This prevents a
  // routine discovery launch from consuming the Free-plan launch slot or
  // browser minutes immediately before the one-minute capture window.
  const discovery = captures.length ? null : await discoverOne(env, showDate, now.toISOString(), options);
  return { enabled: true, showDate, discovery, captures };
}

function snapshot(row, prefix) {
  if (!row[`${prefix}_snapshot_id`]) return null;
  return {
    phase: row[`${prefix}_phase`] || null, sold: Number(row[`${prefix}_sold`] || 0),
    capacity: Number(row[`${prefix}_capacity`] || 0), collectionPaise: Number(row[`${prefix}_collection_paise`] || 0),
    occupancyPercent: Number(row[`${prefix}_occupancy_percent`] || 0), capturedAt: row[`${prefix}_captured_at`],
    source: row[`${prefix}_source`] || null, categories: jsonValue(row[`${prefix}_categories_json`], [])
  };
}

const jobStatus = (row, phase) => ({
  status: row[`${phase}_job_status`] || "not_scheduled", attempts: Number(row[`${phase}_job_attempts`] || 0),
  dueAt: row[`${phase}_due_at`] || null, deadlineAt: row[`${phase}_deadline_at`] || null,
  lastError: row[`${phase}_last_error`] || null
});

export async function bmsTestingDashboard(env, { date, venueCode = "ALL" }) {
  if (!bmsTestingEnabled(env)) return { enabled: false, date, venueCode, summary: null, shows: [], discovery: [] };
  const filter = venueCode === "ALL" ? "" : "AND test.venue_code=?";
  const result = await env.DB.prepare(`SELECT test.*,
    ini.id AS initial_snapshot_id, ini.phase AS initial_phase, ini.sold AS initial_sold,
    ini.capacity AS initial_capacity, ini.collection_paise AS initial_collection_paise,
    ini.occupancy_percent AS initial_occupancy_percent, ini.captured_at AS initial_captured_at,
    ini.source AS initial_source, ini.categories_json AS initial_categories_json,
    fin.id AS final_snapshot_id, fin.phase AS final_phase, fin.sold AS final_sold,
    fin.capacity AS final_capacity, fin.collection_paise AS final_collection_paise,
    fin.occupancy_percent AS final_occupancy_percent, fin.captured_at AS final_captured_at,
    fin.source AS final_source, fin.categories_json AS final_categories_json,
    ij.status AS initial_job_status, ij.attempts AS initial_job_attempts, ij.due_at AS initial_due_at,
    ij.deadline_at AS initial_deadline_at, ij.last_error AS initial_last_error,
    fj.status AS final_job_status, fj.attempts AS final_job_attempts, fj.due_at AS final_due_at,
    fj.deadline_at AS final_deadline_at, fj.last_error AS final_last_error,
    ps.id AS collector_snapshot_id, ps.sold AS collector_sold, ps.capacity AS collector_capacity,
    ps.collection_paise AS collector_collection_paise, ps.occupancy_percent AS collector_occupancy_percent,
    ps.captured_at AS collector_captured_at, ps.source AS collector_source,
    ps.categories_json AS collector_categories_json
    FROM bms_testing_shows test
    LEFT JOIN bms_testing_snapshots ini ON ini.testing_show_id=test.id AND ini.phase='initial'
    LEFT JOIN bms_testing_snapshots fin ON fin.testing_show_id=test.id AND fin.phase='final'
    LEFT JOIN bms_testing_capture_jobs ij ON ij.testing_show_id=test.id AND ij.phase='initial'
    LEFT JOIN bms_testing_capture_jobs fj ON fj.testing_show_id=test.id AND fj.phase='final'
    LEFT JOIN shows prod ON prod.id=(SELECT candidate.id FROM shows candidate WHERE candidate.venue_code=test.venue_code
      AND candidate.show_date=test.show_date AND candidate.session_id=test.session_id AND candidate.is_current=1
      ORDER BY candidate.updated_at DESC LIMIT 1)
    LEFT JOIN snapshots ps ON ps.id=(SELECT captured.id FROM snapshots captured WHERE captured.show_id=prod.id
      ORDER BY captured.is_final DESC, captured.captured_at DESC LIMIT 1)
    WHERE test.show_date=? AND test.is_current=1 ${filter}
    ORDER BY test.start_at, CASE test.venue_code WHEN 'RTDM' THEN 1 WHEN 'ASRM' THEN 2 WHEN 'SKMD' THEN 3 WHEN 'MSDR' THEN 4 WHEN 'SUTD' THEN 5 WHEN 'SCM' THEN 6 ELSE 7 END`)
    .bind(...(venueCode === "ALL" ? [date] : [date, venueCode])).all();
  const shows = (result.results || []).map((row) => {
    const initial = snapshot(row, "initial"), final = snapshot(row, "final"), collector = snapshot(row, "collector");
    const preferred = final || initial;
    return {
      id: String(row.id), venueCode: row.venue_code, venueName: row.venue_name,
      movieTitle: row.movie_title, showTime: row.show_time_label, startAt: row.start_at,
      cutoffAt: row.cutoff_at, provider: row.provider || "bookmyshow", initial, final, preferred, collector,
      comparison: preferred && collector ? { tickets: preferred.sold - collector.sold, collectionPaise: preferred.collectionPaise - collector.collectionPaise, exactTickets: preferred.sold === collector.sold } : null,
      jobs: { initial: jobStatus(row, "initial"), final: jobStatus(row, "final") }
    };
  });
  const finals = shows.filter((show) => show.final);
  const tickets = finals.reduce((sum, show) => sum + show.final.sold, 0);
  const capacity = finals.reduce((sum, show) => sum + show.final.capacity, 0);
  const collectionPaise = finals.reduce((sum, show) => sum + show.final.collectionPaise, 0);
  const discovery = await env.DB.prepare("SELECT * FROM bms_testing_discovery_state WHERE show_date=? ORDER BY venue_code").bind(date).all();
  const refreshedAt = new Date();
  const discoveryActionable = bmsDiscoveryIsActionable(date, shows, refreshedAt);
  const discoveryRows = (discovery.results || []).map((item) => ({
    ...item,
    actionable: discoveryActionable && item.last_status === "failed"
  }));
  const failedCaptures = shows.filter((show) => show.jobs.final.status === "failed").length;
  const failedDiscoveries = discoveryRows.filter((item) => item.actionable &&
    (venueCode === "ALL" || item.venue_code === venueCode)).length;
  return {
    enabled: true, mode: "provider-final-server-testing", date, venueCode, refreshedAt: refreshedAt.toISOString(),
    summary: { shows: shows.length, initialCaptured: shows.filter((show) => show.initial).length,
      finalCaptured: finals.length, failed: failedCaptures + failedDiscoveries,
      unavailable: tickets, tickets, capacity, estimatedCollectionPaise: collectionPaise, collectionPaise,
      occupancyPercent: capacity ? Math.round((tickets / capacity) * 10_000) / 100 : 0,
      exactMatches: shows.filter((show) => show.comparison?.exactTickets).length },
    discovery: discoveryRows, shows
  };
}
