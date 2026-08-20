import { calculateCollection, bmsCodeToIso, captureAtFromCutoff, isoDateFromCode } from "@skct/core";
import { config } from "./config.js";
import { pool, reconcileDiscoveredShows, saveSnapshot } from "./db.js";

function requiredString(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

export function requireCaptureAgent(request, response, next) {
  if (!config.captureAgentToken || request.get("authorization") !== `Bearer ${config.captureAgentToken}`) {
    return response.status(401).json({ error: "unauthorized" });
  }
  next();
}

export function normalizeAgentShows(body) {
  const venueCode = requiredString(body.venueCode, "venueCode");
  if (venueCode !== "SKMD") throw new Error("Only SKMD is configured");
  const dateCode = requiredString(body.dateCode, "dateCode");
  if (!/^\d{8}$/.test(dateCode)) throw new Error("dateCode must be YYYYMMDD");
  const venue = config.venues.find((item) => item.venueCode === venueCode);

  return (body.shows || []).map((raw) => {
    const eventCode = requiredString(raw.eventCode, "eventCode");
    const sessionId = requiredString(raw.sessionId, "sessionId");
    const showTimeCode = requiredString(raw.showTimeCode, "showTimeCode");
    const showDateTime = requiredString(raw.showDateTime, "showDateTime");
    const cutoffDateTime = requiredString(raw.cutoffDateTime, "cutoffDateTime");
    const startAt = bmsCodeToIso(showDateTime);
    const cutoffAt = bmsCodeToIso(cutoffDateTime);
    const cutoffMinutes = (new Date(cutoffAt) - new Date(startAt)) / 60_000;
    if (cutoffMinutes < 1 || cutoffMinutes > 30) throw new Error("Unexpected BookMyShow cutoff interval");
    const naturalKey = [venueCode, dateCode, showTimeCode, sessionId, eventCode].join(":");

    return {
      naturalKey,
      slotKey: [venueCode, dateCode, showTimeCode].join(":"),
      venueCode,
      venueName: venue.name,
      showDate: isoDateFromCode(dateCode),
      showDateCode: dateCode,
      showTimeCode,
      showTimeLabel: requiredString(raw.showTimeLabel, "showTimeLabel"),
      startAt,
      cutoffAt,
      captureAt: captureAtFromCutoff(cutoffAt, venue.captureBeforeCutoffMinutes ?? 1),
      sessionId,
      eventCode,
      movieTitle: requiredString(raw.movieTitle, "movieTitle"),
      movieVariant: raw.movieVariant || raw.movieTitle,
      language: raw.language || "",
      format: raw.format || "",
      attributes: raw.attributes || "",
      screenName: raw.screenName || "",
      advertisedCategories: (raw.categories || []).map((category) => ({
        name: requiredString(category.name, "category.name"),
        priceCode: category.priceCode || "",
        listPricePaise: Number(category.listPricePaise || 0)
      })),
      seatLayoutUrl: `https://in.bookmyshow.com/movies/mdnp/seat-layout/${eventCode}/${venueCode}/${sessionId}/${dateCode}`
    };
  });
}

export async function ingestAgentDiscovery(body) {
  const venue = config.venues.find((item) => item.venueCode === body.venueCode);
  const shows = normalizeAgentShows(body);
  const result = await reconcileDiscoveredShows(venue, body.dateCode, shows);
  return {
    shows: shows.length,
    added: result.changes.added.length,
    replaced: result.changes.replaced.length,
    removed: result.changes.removed.length
  };
}

export async function ingestAgentCapture(body) {
  const naturalKey = requiredString(body.naturalKey, "naturalKey");
  const result = await pool.query(`SELECT * FROM shows WHERE natural_key=$1 AND is_current=true`, [naturalKey]);
  const show = result.rows[0];
  if (!show) throw new Error("The show is no longer the current session for this slot");
  const capturedAt = new Date(requiredString(body.capturedAt, "capturedAt"));
  if (!Number.isFinite(capturedAt.getTime())) throw new Error("capturedAt is invalid");
  if (capturedAt < new Date(show.capture_at) || capturedAt >= new Date(show.cutoff_at)) {
    throw new Error("Capture was outside the final booking minute");
  }
  const calculated = calculateCollection(body.categories || []);
  if (!calculated.capacity) throw new Error("Capture contained no seats");
  if (calculated.unknown) throw new Error("Capture contained unknown seat states");
  const snapshot = {
    ...calculated,
    capturedAt: capturedAt.toISOString(),
    captureMinute: body.captureMinute || capturedAt.toISOString().slice(0, 16),
    source: "local-chrome-extension",
    rawHash: body.rawHash || null
  };
  const saved = await saveSnapshot(show, snapshot, new Date(show.cutoff_at));
  return { snapshotId: String(saved.id), sold: snapshot.sold, collectionPaise: snapshot.collectionPaise };
}
