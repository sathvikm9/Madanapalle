import { pool } from "./db.js";
import { config } from "./config.js";

export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

export async function getDashboard(date, venueCode = "SKMD") {
  const allTheatres = venueCode === "ALL";
  const selectedVenue = allTheatres ? { venueCode: "ALL", name: "All theatres", shortName: "All theatres" }
    : config.venues.find((venue) => venue.venueCode === venueCode);
  if (!selectedVenue) throw new Error(`Venue ${venueCode} is not configured`);
  const showWhere = allTheatres ? "s.show_date=$1" : "s.venue_code=$1 AND s.show_date=$2";
  const showParameters = allTheatres ? [date] : [venueCode, date];
  const showResult = await pool.query(
    `SELECT
      s.*,
      snap.id AS snapshot_id,
      snap.captured_at,
      snap.capacity,
      snap.available,
      snap.sold,
      snap.unknown,
      snap.collection_paise,
      snap.occupancy_percent,
      snap.is_final,
      snap.source
    FROM shows s
    LEFT JOIN LATERAL (
      SELECT * FROM snapshots WHERE show_id=s.id ORDER BY captured_at DESC LIMIT 1
    ) snap ON true
    WHERE ${showWhere}
    ORDER BY s.start_at ASC, s.venue_code ASC, s.is_current DESC, s.first_seen_at ASC`,
    showParameters
  );
  const snapshotIds = showResult.rows.map((row) => row.snapshot_id).filter(Boolean);
  const categories = snapshotIds.length
    ? await pool.query(
      `SELECT * FROM snapshot_categories WHERE snapshot_id = ANY($1::bigint[]) ORDER BY id`,
      [snapshotIds]
    )
    : { rows: [] };
  const categoriesBySnapshot = new Map();
  for (const category of categories.rows) {
    if (!categoriesBySnapshot.has(String(category.snapshot_id))) categoriesBySnapshot.set(String(category.snapshot_id), []);
    categoriesBySnapshot.get(String(category.snapshot_id)).push({
      name: category.name,
      listPricePaise: category.list_price_paise,
      netPricePaise: category.net_price_paise,
      capacity: category.capacity,
      available: category.available,
      sold: category.sold,
      unknown: category.unknown,
      collectionPaise: Number(category.collection_paise)
    });
  }

  const changesWhere = allTheatres ? "e.show_date=$1" : "e.venue_code=$1 AND e.show_date=$2";
  const changes = await pool.query(
    `SELECT e.*, previous.movie_title AS previous_movie, next_show.movie_title AS next_movie,
      previous.show_time_label AS show_time_label
     FROM schedule_events e
     LEFT JOIN shows previous ON previous.id=e.previous_show_id
     LEFT JOIN shows next_show ON next_show.id=e.next_show_id
     WHERE ${changesWhere} AND e.event_type IN ('replaced','removed')
     ORDER BY e.observed_at DESC`,
    showParameters
  );

  const shows = showResult.rows.map((row) => ({
    id: String(row.id),
    venueCode: row.venue_code,
    venueName: row.venue_name,
    venueShortName: config.venues.find((venue) => venue.venueCode === row.venue_code)?.shortName || row.venue_code,
    sessionId: row.session_id,
    eventCode: row.event_code,
    movieTitle: row.movie_title,
    movieVariant: row.movie_variant,
    language: row.language,
    format: row.format,
    showTime: row.show_time_label,
    startAt: row.start_at,
    captureDueAt: row.capture_at,
    cutoffAt: row.cutoff_at,
    isCurrent: row.is_current,
    status: row.status,
    captureAttempts: row.capture_attempts,
    lastError: row.last_error,
    advertisedCategories: row.advertised_categories,
    snapshot: row.snapshot_id ? {
      id: String(row.snapshot_id),
      capturedAt: row.captured_at,
      capacity: row.capacity,
      available: row.available,
      sold: row.sold,
      unknown: row.unknown,
      collectionPaise: Number(row.collection_paise),
      occupancyPercent: Number(row.occupancy_percent),
      isFinal: row.is_final,
      source: row.source,
      categories: categoriesBySnapshot.get(String(row.snapshot_id)) || []
    } : null
  }));

  const currentShows = shows.filter((show) => show.isCurrent);
  const finalized = currentShows.filter((show) => show.status === "completed" && show.snapshot);
  const totals = finalized.reduce(
    (sum, show) => ({
      ticketsSold: sum.ticketsSold + show.snapshot.sold,
      collectionPaise: sum.collectionPaise + show.snapshot.collectionPaise,
      capacity: sum.capacity + show.snapshot.capacity
    }),
    { ticketsSold: 0, collectionPaise: 0, capacity: 0 }
  );

  return {
    date,
    timezone: "Asia/Kolkata",
    venue: { code: venueCode, name: selectedVenue.name, shortName: selectedVenue.shortName },
    venues: [
      { code: "ALL", name: "All theatres", shortName: "All theatres" },
      ...config.venues.map((venue) => ({ code: venue.venueCode, name: venue.name, shortName: venue.shortName }))
    ],
    generatedAt: new Date().toISOString(),
    summary: {
      totalShows: currentShows.length,
      finalizedShows: finalized.length,
      pendingShows: currentShows.filter((show) => ["scheduled", "capturing"].includes(show.status)).length,
      missedShows: currentShows.filter((show) => show.status === "missed").length,
      ...totals,
      occupancyPercent: totals.capacity
        ? Number(((totals.ticketsSold / totals.capacity) * 100).toFixed(2))
        : 0
    },
    shows,
    scheduleChanges: changes.rows.map((event) => ({
      id: String(event.id),
      venueCode: event.venue_code,
      venueName: config.venues.find((venue) => venue.venueCode === event.venue_code)?.shortName || event.venue_code,
      type: event.event_type,
      showTime: event.show_time_label,
      previousMovie: event.previous_movie,
      nextMovie: event.next_movie,
      observedAt: event.observed_at
    }))
  };
}
