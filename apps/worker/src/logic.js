import {
  bmsCodeToIso,
  calculateCollection,
  captureAtFromStart,
  isoDateFromCode
} from "@skct/core";
import { venueForCode } from "./venues.js";

export class RequestError extends Error {
  constructor(message, status = 400, code = "invalid_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requiredString(value, name, maximum = 500) {
  const text = String(value ?? "").trim();
  if (!text) throw new RequestError(`${name} is required`);
  if (text.length > maximum) throw new RequestError(`${name} is too long`);
  return text;
}

export function validDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

export function validDateCode(value) {
  const text = String(value || "");
  return /^\d{8}$/.test(text) && validDate(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`);
}

function safeInteger(value, name, maximum = 100_000) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw new RequestError(`${name} must be a non-negative integer`);
  }
  return number;
}

function normalizeAdvertisedCategories(categories) {
  if (!Array.isArray(categories) || categories.length > 20) {
    throw new RequestError("categories must be an array with at most 20 entries");
  }
  return categories.map((category, index) => ({
    name: requiredString(category?.name, `categories[${index}].name`, 100),
    priceCode: String(category?.priceCode || "").slice(0, 100),
    listPricePaise: safeInteger(category?.listPricePaise, `categories[${index}].listPricePaise`, 100_000)
  }));
}

export function normalizeDiscovery(body) {
  if (!body || typeof body !== "object") throw new RequestError("JSON body is required");
  const venueCode = requiredString(body.venueCode, "venueCode", 20);
  const venue = venueForCode(venueCode);
  if (!venue) throw new RequestError(`Venue ${venueCode} is not configured`);
  const dateCode = requiredString(body.dateCode, "dateCode", 8);
  if (!validDateCode(dateCode)) throw new RequestError("dateCode must be a real YYYYMMDD date");
  if (!Array.isArray(body.shows) || body.shows.length > 20) {
    throw new RequestError("shows must be an array with at most 20 entries");
  }

  const naturalKeys = new Set();
  const slotKeys = new Set();
  const shows = body.shows.map((raw, index) => {
    const eventCode = requiredString(raw?.eventCode, `shows[${index}].eventCode`, 50);
    const sessionId = requiredString(raw?.sessionId, `shows[${index}].sessionId`, 50);
    const showTimeCode = requiredString(raw?.showTimeCode, `shows[${index}].showTimeCode`, 20);
    const showDateTime = requiredString(raw?.showDateTime, `shows[${index}].showDateTime`, 12);
    const cutoffDateTime = requiredString(raw?.cutoffDateTime, `shows[${index}].cutoffDateTime`, 12);
    if (!/^\d{12}$/.test(showDateTime) || !/^\d{12}$/.test(cutoffDateTime)) {
      throw new RequestError(`shows[${index}] contains an invalid BookMyShow datetime`);
    }
    const startAt = new Date(bmsCodeToIso(showDateTime)).toISOString();
    const cutoffAt = new Date(bmsCodeToIso(cutoffDateTime)).toISOString();
    const cutoffMinutes = (new Date(cutoffAt) - new Date(startAt)) / 60_000;
    if (cutoffMinutes < 1 || cutoffMinutes > 30) {
      throw new RequestError(`shows[${index}] has an unexpected BookMyShow cutoff interval`);
    }
    if (showDateTime.slice(0, 8) !== dateCode || cutoffDateTime.slice(0, 8) !== dateCode) {
      throw new RequestError(`shows[${index}] does not belong to ${dateCode}`);
    }

    const naturalKey = [venueCode, dateCode, showTimeCode, sessionId, eventCode].join(":");
    const slotKey = [venueCode, dateCode, showTimeCode].join(":");
    if (naturalKeys.has(naturalKey)) throw new RequestError(`Duplicate show ${naturalKey}`);
    if (slotKeys.has(slotKey)) throw new RequestError(`Duplicate showtime slot ${slotKey}`);
    naturalKeys.add(naturalKey);
    slotKeys.add(slotKey);

    return {
      naturalKey,
      slotKey,
      venueCode,
      venueName: venue.name,
      showDate: isoDateFromCode(dateCode),
      showDateCode: dateCode,
      showTimeCode,
      showTimeLabel: requiredString(raw?.showTimeLabel, `shows[${index}].showTimeLabel`, 30),
      startAt,
      cutoffAt,
      captureAt: captureAtFromStart(startAt, venue.captureStartAfterShowMinutes),
      sessionId,
      eventCode,
      movieTitle: requiredString(raw?.movieTitle, `shows[${index}].movieTitle`, 300),
      movieVariant: String(raw?.movieVariant || raw?.movieTitle).slice(0, 300),
      language: String(raw?.language || "").slice(0, 100),
      format: String(raw?.format || "").slice(0, 100),
      attributes: String(raw?.attributes || "").slice(0, 500),
      screenName: String(raw?.screenName || "").slice(0, 100),
      advertisedCategories: normalizeAdvertisedCategories(raw?.categories || []),
      seatLayoutUrl: `https://in.bookmyshow.com/movies/mdnp/seat-layout/${eventCode}/${venueCode}/${sessionId}/${dateCode}`
    };
  });

  return { venueCode, dateCode, showDate: isoDateFromCode(dateCode), shows };
}

export function normalizeCapture(body, show, receivedAt = new Date()) {
  if (!body || typeof body !== "object") throw new RequestError("JSON body is required");
  const naturalKey = requiredString(body.naturalKey, "naturalKey", 300);
  if (!show || naturalKey !== show.natural_key || !show.is_current) {
    throw new RequestError("The show is no longer the current session for this slot", 409, "stale_show");
  }

  const capturedAt = new Date(requiredString(body.capturedAt, "capturedAt", 50));
  if (!Number.isFinite(capturedAt.getTime())) throw new RequestError("capturedAt is invalid");
  const captureStart = new Date(show.capture_at);
  const cutoff = new Date(show.cutoff_at);
  if (capturedAt < captureStart || capturedAt >= cutoff) {
    throw new RequestError("Capture was outside the configured booking window", 409, "outside_capture_window");
  }
  if (Math.abs(receivedAt.getTime() - capturedAt.getTime()) > 5 * 60_000) {
    throw new RequestError("Laptop clock differs from server time by more than five minutes", 409, "clock_skew");
  }
  if (!Array.isArray(body.categories) || !body.categories.length || body.categories.length > 20) {
    throw new RequestError("Capture must contain between 1 and 20 categories");
  }

  const categories = body.categories.map((category, index) => {
    const capacity = safeInteger(category?.capacity, `categories[${index}].capacity`, 5_000);
    const available = safeInteger(category?.available, `categories[${index}].available`, 5_000);
    const sold = safeInteger(category?.sold, `categories[${index}].sold`, 5_000);
    const unknown = safeInteger(category?.unknown, `categories[${index}].unknown`, 5_000);
    if (capacity !== available + sold + unknown) {
      throw new RequestError(`categories[${index}] seat totals do not match capacity`);
    }
    return {
      name: requiredString(category?.name, `categories[${index}].name`, 100),
      price: Number(category?.price ?? category?.listPrice ?? 0),
      listPricePaise: category?.listPricePaise,
      capacity,
      available,
      sold,
      unknown
    };
  });

  const calculated = calculateCollection(categories);
  if (!calculated.capacity) throw new RequestError("Capture contained no seats");
  if (calculated.unknown) throw new RequestError("Capture contained unknown seat states");
  if (calculated.categories.some((category) => category.listPricePaise <= 0 || category.listPricePaise > 100_000)) {
    throw new RequestError("Capture contained an invalid ticket price");
  }

  return {
    naturalKey,
    ...calculated,
    capturedAt: capturedAt.toISOString(),
    receivedAt: receivedAt.toISOString(),
    captureMinute: String(body.captureMinute || capturedAt.toISOString().slice(0, 16)).slice(0, 50),
    attemptId: body.attemptId ? String(body.attemptId).slice(0, 100) : null,
    source: "local-chrome-extension",
    rawHash: body.rawHash ? String(body.rawHash).slice(0, 128) : null
  };
}

export function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
