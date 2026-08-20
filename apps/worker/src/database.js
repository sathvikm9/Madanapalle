import { classifyScheduleChanges } from "@skct/core";
import { parseJson, RequestError } from "./logic.js";

const UPSERT_SHOW = `
  INSERT INTO shows (
    natural_key, slot_key, venue_code, venue_name, show_date, show_date_code,
    show_time_code, show_time_label, start_at, cutoff_at, capture_at, session_id,
    event_code, movie_title, movie_variant, language, format, attributes, screen_name,
    seat_layout_url, advertised_categories_json, is_current, status,
    first_seen_at, last_seen_at, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'scheduled',?,?,?,?)
  ON CONFLICT(natural_key) DO UPDATE SET
    cutoff_at=excluded.cutoff_at,
    capture_at=excluded.capture_at,
    movie_title=excluded.movie_title,
    movie_variant=excluded.movie_variant,
    language=excluded.language,
    format=excluded.format,
    attributes=excluded.attributes,
    screen_name=excluded.screen_name,
    seat_layout_url=excluded.seat_layout_url,
    advertised_categories_json=excluded.advertised_categories_json,
    is_current=1,
    status=CASE WHEN shows.status IN ('removed','replaced') THEN 'scheduled' ELSE shows.status END,
    last_seen_at=excluded.last_seen_at,
    replaced_at=NULL,
    removed_at=NULL,
    updated_at=excluded.updated_at
`;

function showValues(show, now) {
  return [
    show.naturalKey,
    show.slotKey,
    show.venueCode,
    show.venueName,
    show.showDate,
    show.showDateCode,
    show.showTimeCode,
    show.showTimeLabel,
    show.startAt,
    show.cutoffAt,
    show.captureAt,
    show.sessionId,
    show.eventCode,
    show.movieTitle,
    show.movieVariant,
    show.language,
    show.format,
    show.attributes,
    show.screenName,
    show.seatLayoutUrl,
    JSON.stringify(show.advertisedCategories),
    now,
    now,
    now,
    now
  ];
}

function coreShow(row) {
  return {
    id: row.id,
    naturalKey: row.natural_key,
    slotKey: row.slot_key,
    isCurrent: Boolean(row.is_current)
  };
}

export async function reconcileDiscovery(db, discovery, now = new Date()) {
  const observedAt = now.toISOString();
  const existingResult = await db.prepare(
    `SELECT * FROM shows WHERE venue_code=? AND show_date=? AND is_current=1 ORDER BY start_at`
  ).bind(discovery.venueCode, discovery.showDate).all();
  const existing = existingResult.results || [];
  if (!discovery.shows.length && existing.length) {
    throw new RequestError(
      "BookMyShow returned an empty schedule while known shows still exist; refusing to remove them from one observation",
      409,
      "suspicious_empty_schedule"
    );
  }

  const changes = classifyScheduleChanges(existing.map(coreShow), discovery.shows);
  const statements = discovery.shows.map((show) => db.prepare(UPSERT_SHOW).bind(...showValues(show, observedAt)));

  for (const change of changes.replaced) {
    statements.push(
      db.prepare(
        `UPDATE shows SET is_current=0, status='replaced', replaced_at=?, updated_at=? WHERE id=?`
      ).bind(observedAt, observedAt, change.previous.id),
      db.prepare(
        `INSERT INTO schedule_events (
          venue_code, show_date, slot_key, event_type, previous_show_id, next_show_id, details_json, observed_at
        ) VALUES (?, ?, ?, 'replaced', ?, (SELECT id FROM shows WHERE natural_key=?), ?, ?)`
      ).bind(
        discovery.venueCode,
        discovery.showDate,
        change.next.slotKey,
        change.previous.id,
        change.next.naturalKey,
        JSON.stringify({
          previousNaturalKey: change.previous.naturalKey,
          nextNaturalKey: change.next.naturalKey
        }),
        observedAt
      )
    );
  }

  for (const removed of changes.removed) {
    statements.push(
      db.prepare(
        `UPDATE shows SET is_current=0,
          status=CASE WHEN status='completed' THEN status ELSE 'removed' END,
          removed_at=?, updated_at=? WHERE id=?`
      ).bind(observedAt, observedAt, removed.id),
      db.prepare(
        `INSERT INTO schedule_events (
          venue_code, show_date, slot_key, event_type, previous_show_id, details_json, observed_at
        ) VALUES (?, ?, ?, 'removed', ?, '{}', ?)`
      ).bind(discovery.venueCode, discovery.showDate, removed.slotKey, removed.id, observedAt)
    );
  }

  for (const added of changes.added) {
    statements.push(
      db.prepare(
        `INSERT INTO schedule_events (
          venue_code, show_date, slot_key, event_type, next_show_id, details_json, observed_at
        ) VALUES (?, ?, ?, 'added', (SELECT id FROM shows WHERE natural_key=?), '{}', ?)`
      ).bind(discovery.venueCode, discovery.showDate, added.slotKey, added.naturalKey, observedAt)
    );
  }

  statements.push(
    db.prepare(
      `INSERT INTO collector_runs (
        run_type, venue_code, target_date, status, started_at, finished_at, details_json
      ) VALUES ('discovery', ?, ?, 'success', ?, ?, ?)`
    ).bind(
      discovery.venueCode,
      discovery.showDate,
      observedAt,
      observedAt,
      JSON.stringify({
        shows: discovery.shows.length,
        added: changes.added.length,
        replaced: changes.replaced.length,
        removed: changes.removed.length
      })
    )
  );

  await db.batch(statements);
  return {
    shows: discovery.shows.length,
    added: changes.added.length,
    replaced: changes.replaced.length,
    removed: changes.removed.length
  };
}

export async function currentShow(db, naturalKey) {
  return db.prepare(`SELECT * FROM shows WHERE natural_key=? AND is_current=1`).bind(naturalKey).first();
}

export async function saveCapture(db, show, capture) {
  const createdAt = new Date().toISOString();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO snapshots (
        show_id, captured_at, received_at, capture_minute, source, capacity, available,
        sold, unknown, collection_paise, occupancy_percent, categories_json,
        is_final, raw_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(
      show.id,
      capture.capturedAt,
      capture.receivedAt,
      capture.captureMinute,
      capture.source,
      capture.capacity,
      capture.available,
      capture.sold,
      capture.unknown,
      capture.collectionPaise,
      capture.occupancyPercent,
      JSON.stringify(capture.categories),
      capture.rawHash,
      createdAt
    ),
    db.prepare(
      `UPDATE shows SET status='capturing', capture_attempts=capture_attempts+1,
        last_capture_at=?, last_error=NULL, updated_at=? WHERE id=?`
    ).bind(capture.capturedAt, createdAt, show.id),
    db.prepare(
      `INSERT INTO collector_runs (
        run_type, venue_code, target_date, show_id, status, started_at, finished_at, details_json
      ) VALUES ('capture', ?, ?, ?, 'success', ?, ?, ?)`
    ).bind(
      show.venue_code,
      show.show_date,
      show.id,
      createdAt,
      createdAt,
      JSON.stringify({ sold: capture.sold, collectionPaise: capture.collectionPaise, capturedAt: capture.capturedAt })
    )
  ]);
  return {
    snapshotId: String(results[0]?.meta?.last_row_id ?? ""),
    sold: capture.sold,
    collectionPaise: capture.collectionPaise
  };
}

export async function finalizeExpiredShows(db, now = new Date()) {
  const timestamp = now.toISOString();
  const expired = await db.prepare(
    `SELECT id FROM shows
     WHERE is_current=1 AND status IN ('scheduled','capturing') AND cutoff_at <= ?`
  ).bind(timestamp).all();
  if (!expired.results?.length) return 0;

  await db.batch([
    db.prepare(
      `UPDATE snapshots SET is_final=1
       WHERE id IN (
         SELECT (SELECT snapshots.id FROM snapshots
                 WHERE snapshots.show_id=shows.id
                 ORDER BY captured_at DESC LIMIT 1)
         FROM shows
         WHERE is_current=1 AND status IN ('scheduled','capturing') AND cutoff_at <= ?
       )`
    ).bind(timestamp),
    db.prepare(
      `UPDATE shows SET
         status=CASE WHEN EXISTS (SELECT 1 FROM snapshots WHERE snapshots.show_id=shows.id)
                     THEN 'completed' ELSE 'missed' END,
         last_error=CASE WHEN EXISTS (SELECT 1 FROM snapshots WHERE snapshots.show_id=shows.id)
                         THEN NULL ELSE COALESCE(last_error, 'No successful capture before cutoff') END,
         updated_at=?
       WHERE is_current=1 AND status IN ('scheduled','capturing') AND cutoff_at <= ?`
    ).bind(timestamp, timestamp)
  ]);
  return expired.results.length;
}

export async function dashboardData(db, date, venueCode, now = new Date()) {
  await finalizeExpiredShows(db, now);
  const showResult = await db.prepare(
    `SELECT
      shows.*,
      snapshots.id AS snapshot_id,
      snapshots.captured_at,
      snapshots.capacity,
      snapshots.available,
      snapshots.sold,
      snapshots.unknown,
      snapshots.collection_paise,
      snapshots.occupancy_percent,
      snapshots.categories_json,
      snapshots.is_final,
      snapshots.source
     FROM shows
     LEFT JOIN snapshots ON snapshots.id=(
       SELECT id FROM snapshots latest WHERE latest.show_id=shows.id ORDER BY captured_at DESC LIMIT 1
     )
     WHERE shows.venue_code=? AND shows.show_date=?
     ORDER BY shows.start_at ASC, shows.is_current DESC, shows.first_seen_at ASC`
  ).bind(venueCode, date).all();

  const changesResult = await db.prepare(
    `SELECT events.*, previous.movie_title AS previous_movie,
      next_show.movie_title AS next_movie, previous.show_time_label AS show_time_label
     FROM schedule_events events
     LEFT JOIN shows previous ON previous.id=events.previous_show_id
     LEFT JOIN shows next_show ON next_show.id=events.next_show_id
     WHERE events.venue_code=? AND events.show_date=? AND events.event_type IN ('replaced','removed')
     ORDER BY events.observed_at DESC`
  ).bind(venueCode, date).all();

  const shows = (showResult.results || []).map((row) => ({
    id: String(row.id),
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
    isCurrent: Boolean(row.is_current),
    status: row.status,
    captureAttempts: row.capture_attempts,
    lastError: row.last_error,
    advertisedCategories: parseJson(row.advertised_categories_json, []),
    snapshot: row.snapshot_id ? {
      id: String(row.snapshot_id),
      capturedAt: row.captured_at,
      capacity: row.capacity,
      available: row.available,
      sold: row.sold,
      unknown: row.unknown,
      collectionPaise: Number(row.collection_paise),
      occupancyPercent: Number(row.occupancy_percent),
      isFinal: Boolean(row.is_final),
      source: row.source,
      categories: parseJson(row.categories_json, [])
    } : null
  }));

  const currentShows = shows.filter((show) => show.isCurrent);
  const finalized = currentShows.filter((show) => show.status === "completed" && show.snapshot);
  const totals = finalized.reduce((sum, show) => ({
    ticketsSold: sum.ticketsSold + show.snapshot.sold,
    collectionPaise: sum.collectionPaise + show.snapshot.collectionPaise,
    capacity: sum.capacity + show.snapshot.capacity
  }), { ticketsSold: 0, collectionPaise: 0, capacity: 0 });

  return {
    date,
    timezone: "Asia/Kolkata",
    venue: { code: venueCode, name: "Sri Krishna A/C 4K Dolby Atmos: Madanapalle" },
    generatedAt: now.toISOString(),
    summary: {
      totalShows: currentShows.length,
      finalizedShows: finalized.length,
      pendingShows: currentShows.filter((show) => ["scheduled", "capturing"].includes(show.status)).length,
      missedShows: currentShows.filter((show) => show.status === "missed").length,
      ...totals,
      occupancyPercent: totals.capacity ? Number(((totals.ticketsSold / totals.capacity) * 100).toFixed(2)) : 0
    },
    shows,
    scheduleChanges: (changesResult.results || []).map((event) => ({
      id: String(event.id),
      type: event.event_type,
      showTime: event.show_time_label,
      previousMovie: event.previous_movie,
      nextMovie: event.next_movie,
      observedAt: event.observed_at
    }))
  };
}

export async function captureHistory(db, showId) {
  const show = await db.prepare(`SELECT id FROM shows WHERE id=?`).bind(showId).first();
  if (!show) throw new RequestError("Show was not found", 404, "not_found");
  const result = await db.prepare(
    `SELECT * FROM snapshots WHERE show_id=? ORDER BY captured_at ASC`
  ).bind(showId).all();
  return {
    showId: String(showId),
    snapshots: (result.results || []).map((row) => ({
      id: String(row.id),
      capturedAt: row.captured_at,
      receivedAt: row.received_at,
      source: row.source,
      capacity: row.capacity,
      available: row.available,
      sold: row.sold,
      unknown: row.unknown,
      collectionPaise: Number(row.collection_paise),
      occupancyPercent: Number(row.occupancy_percent),
      isFinal: Boolean(row.is_final),
      categories: parseJson(row.categories_json, [])
    }))
  };
}
