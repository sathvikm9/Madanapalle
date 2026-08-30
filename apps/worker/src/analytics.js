import { parseJson, resolveInternalMovieCodes } from "./logic.js";
import { publicVenues, venueForCode } from "./venues.js";

export const ANALYTICS_FIRST_DATE = "2026-08-21";

function canonicalShows(rows) {
  return resolveInternalMovieCodes(rows.map((row) => ({
    ...row,
    venueCode: row.venue_code,
    eventCode: row.event_code,
    movieTitle: row.movie_title,
    movieVariant: row.movie_variant
  })));
}

function normalizedTitle(value) {
  return String(value || "").trim().toLocaleLowerCase("en-IN");
}

function emptyTotals() {
  return {
    screenedShows: 0,
    capturedShows: 0,
    housefullShows: 0,
    ticketsSold: 0,
    capacity: 0,
    collectionPaise: 0
  };
}

export function buildCapacityProfiles(rows) {
  const profiles = new Map();
  for (const row of rows) {
    if (profiles.has(row.venue_code)) continue;
    const categories = parseJson(row.categories_json, []).filter((category) =>
      Number(category.capacity) > 0 && Number(category.listPricePaise) > 0
    );
    if (!categories.length) continue;

    const tiers = new Map();
    for (const category of categories) {
      const listPricePaise = Number(category.listPricePaise);
      const tier = tiers.get(listPricePaise) || {
        listPricePaise,
        capacity: 0,
        classes: []
      };
      tier.capacity += Number(category.capacity);
      tier.classes.push(String(category.name || "Class"));
      tiers.set(listPricePaise, tier);
    }

    const groupedTiers = Array.from(tiers.values()).sort((left, right) => right.listPricePaise - left.listPricePaise);
    profiles.set(row.venue_code, {
      venueCode: row.venue_code,
      theatreName: venueForCode(row.venue_code)?.shortName || row.venue_code,
      capacity: groupedTiers.reduce((total, tier) => total + tier.capacity, 0),
      sourceCapturedAt: row.captured_at,
      tiers: groupedTiers
    });
  }

  const order = new Map(["SCM", "ASRM", "RTDM", "SKMD"].map((code, index) => [code, index]));
  return Array.from(profiles.values()).sort((left, right) =>
    (order.get(left.venueCode) ?? 99) - (order.get(right.venueCode) ?? 99)
  );
}

function addShow(totals, show) {
  totals.screenedShows += 1;
  if (!show.snapshot_id || show.status !== "completed") return;
  totals.capturedShows += 1;
  totals.ticketsSold += Number(show.sold || 0);
  totals.capacity += Number(show.capacity || 0);
  totals.collectionPaise += Number(show.collection_paise || 0);
  if (Number(show.capacity) > 0 && Number(show.sold) >= Number(show.capacity)) {
    totals.housefullShows += 1;
  }
}

export function summarizeAnalyticsRows(rows, {
  movieTitle,
  venueCode = "ALL",
  startDate,
  endDate,
  now = new Date()
}) {
  const wantedTitle = normalizedTitle(movieTitle);
  const allMovies = movieTitle === "ALL";
  const nowMs = now.getTime();
  const venues = new Map();
  const days = new Map();
  const total = emptyTotals();
  let resolvedTitle = allMovies ? "All movies" : movieTitle;

  for (const show of canonicalShows(rows)) {
    if (!allMovies && normalizedTitle(show.movieTitle) !== wantedTitle) continue;
    if (show.show_date < startDate || show.show_date > endDate) continue;
    if (venueCode !== "ALL" && show.venue_code !== venueCode) continue;
    if (new Date(show.start_at).getTime() > nowMs) continue;

    if (!allMovies) resolvedTitle = show.movieTitle;
    const venue = venues.get(show.venue_code) || {
      code: show.venue_code,
      name: venueForCode(show.venue_code)?.shortName || show.venue_code,
      ...emptyTotals()
    };
    const day = days.get(show.show_date) || {
      date: show.show_date,
      ...emptyTotals()
    };
    addShow(total, show);
    addShow(venue, show);
    addShow(day, show);
    venues.set(show.venue_code, venue);
    days.set(show.show_date, day);
  }

  const venueOrder = new Map(["SCM", "ASRM", "RTDM", "SKMD"].map((code, index) => [code, index]));
  const byVenue = Array.from(venues.values()).sort((left, right) =>
    (venueOrder.get(left.code) ?? 99) - (venueOrder.get(right.code) ?? 99)
  );

  return {
    movieTitle: resolvedTitle,
    venueCode,
    startDate,
    endDate,
    total,
    venues: byVenue,
    days: Array.from(days.values()).sort((left, right) => left.date.localeCompare(right.date))
  };
}

export async function analyticsCatalog(db, now = new Date()) {
  const result = await db.prepare(
    `SELECT venue_code, event_code, movie_title, movie_variant, show_date, start_at
     FROM shows
     WHERE is_current=1 AND show_date>=? AND start_at<=?
     ORDER BY show_date ASC, start_at ASC`
  ).bind(ANALYTICS_FIRST_DATE, now.toISOString()).all();
  const capacityResult = await db.prepare(
    `SELECT shows.venue_code, snapshots.categories_json, snapshots.captured_at
     FROM snapshots
     JOIN shows ON shows.id=snapshots.show_id
     WHERE shows.is_current=1
     ORDER BY snapshots.captured_at DESC`
  ).all();

  const movies = new Map();
  for (const show of canonicalShows(result.results || [])) {
    const key = normalizedTitle(show.movieTitle);
    if (!key) continue;
    const movie = movies.get(key) || {
      title: show.movieTitle,
      firstTrackedDate: show.show_date,
      lastTrackedDate: show.show_date
    };
    if (show.show_date < movie.firstTrackedDate) movie.firstTrackedDate = show.show_date;
    if (show.show_date > movie.lastTrackedDate) movie.lastTrackedDate = show.show_date;
    movies.set(key, movie);
  }

  return {
    firstLiveDate: ANALYTICS_FIRST_DATE,
    generatedAt: now.toISOString(),
    venues: publicVenues(),
    capacityProfiles: buildCapacityProfiles(capacityResult.results || []),
    movies: Array.from(movies.values()).sort((left, right) => left.title.localeCompare(right.title))
  };
}

export async function analyticsSummary(db, filters, now = new Date()) {
  const result = await db.prepare(
    `SELECT
       shows.venue_code,
       shows.event_code,
       shows.movie_title,
       shows.movie_variant,
       shows.show_date,
       shows.start_at,
       shows.status,
       snapshots.id AS snapshot_id,
       snapshots.capacity,
       snapshots.sold,
       snapshots.collection_paise
     FROM shows
     LEFT JOIN snapshots ON snapshots.id=(
       SELECT id FROM snapshots latest WHERE latest.show_id=shows.id ORDER BY captured_at DESC LIMIT 1
     )
     WHERE shows.is_current=1 AND shows.show_date BETWEEN ? AND ?
     ORDER BY shows.start_at ASC, shows.venue_code ASC`
  ).bind(filters.startDate, filters.endDate).all();

  return {
    ...summarizeAnalyticsRows(result.results || [], { ...filters, now }),
    generatedAt: now.toISOString()
  };
}
