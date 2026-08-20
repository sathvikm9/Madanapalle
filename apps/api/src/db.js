import pg from "pg";
import { classifyScheduleChanges } from "@skct/core";
import { config } from "./config.js";

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl });

const schema = `
CREATE TABLE IF NOT EXISTS venues (
  venue_code text PRIMARY KEY,
  name text NOT NULL,
  short_name text NOT NULL,
  slug text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shows (
  id bigserial PRIMARY KEY,
  natural_key text NOT NULL UNIQUE,
  slot_key text NOT NULL,
  venue_code text NOT NULL REFERENCES venues(venue_code),
  show_date date NOT NULL,
  show_date_code text NOT NULL,
  show_time_code text NOT NULL,
  show_time_label text NOT NULL,
  start_at timestamptz NOT NULL,
  cutoff_at timestamptz NOT NULL,
  capture_at timestamptz NOT NULL,
  session_id text NOT NULL,
  event_code text NOT NULL,
  movie_title text NOT NULL,
  movie_variant text NOT NULL,
  language text NOT NULL DEFAULT '',
  format text NOT NULL DEFAULT '',
  attributes text NOT NULL DEFAULT '',
  screen_name text NOT NULL DEFAULT '',
  seat_layout_url text NOT NULL,
  advertised_categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_current boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'scheduled',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  replaced_at timestamptz,
  removed_at timestamptz,
  capture_attempts integer NOT NULL DEFAULT 0,
  next_capture_attempt_at timestamptz,
  last_capture_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shows_due_idx ON shows (is_current, status, capture_at, cutoff_at);
CREATE INDEX IF NOT EXISTS shows_date_idx ON shows (venue_code, show_date, start_at);
CREATE INDEX IF NOT EXISTS shows_slot_idx ON shows (slot_key, is_current);

CREATE TABLE IF NOT EXISTS schedule_events (
  id bigserial PRIMARY KEY,
  venue_code text NOT NULL REFERENCES venues(venue_code),
  show_date date NOT NULL,
  slot_key text,
  event_type text NOT NULL,
  previous_show_id bigint REFERENCES shows(id),
  next_show_id bigint REFERENCES shows(id),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collector_runs (
  id bigserial PRIMARY KEY,
  run_type text NOT NULL,
  venue_code text,
  target_date date,
  show_id bigint REFERENCES shows(id),
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS snapshots (
  id bigserial PRIMARY KEY,
  show_id bigint NOT NULL REFERENCES shows(id),
  captured_at timestamptz NOT NULL,
  capture_minute text NOT NULL,
  source text NOT NULL,
  capacity integer NOT NULL,
  available integer NOT NULL,
  sold integer NOT NULL,
  unknown integer NOT NULL DEFAULT 0,
  collection_paise bigint NOT NULL,
  occupancy_percent numeric(6,2) NOT NULL,
  is_final boolean NOT NULL DEFAULT false,
  raw_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS snapshots_show_idx ON snapshots (show_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS snapshot_categories (
  id bigserial PRIMARY KEY,
  snapshot_id bigint NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  name text NOT NULL,
  list_price_paise integer NOT NULL,
  net_price_paise integer NOT NULL,
  capacity integer NOT NULL,
  available integer NOT NULL,
  sold integer NOT NULL,
  unknown integer NOT NULL DEFAULT 0,
  collection_paise bigint NOT NULL
);
`;

export async function migrate() {
  await pool.query(schema);
  for (const venue of config.venues) {
    await pool.query(
      `INSERT INTO venues (venue_code, name, short_name, slug, timezone, active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (venue_code) DO UPDATE SET
         name = EXCLUDED.name, short_name = EXCLUDED.short_name, slug = EXCLUDED.slug,
         timezone = EXCLUDED.timezone, active = true, updated_at = now()`,
      [venue.venueCode, venue.name, venue.shortName, venue.slug, config.timezone]
    );
  }
}

function dbShowToCore(row) {
  return {
    id: row.id,
    naturalKey: row.natural_key,
    slotKey: row.slot_key,
    isCurrent: row.is_current
  };
}

async function insertOrUpdateShow(client, show) {
  const result = await client.query(
    `INSERT INTO shows (
      natural_key, slot_key, venue_code, show_date, show_date_code, show_time_code,
      show_time_label, start_at, cutoff_at, capture_at, session_id, event_code,
      movie_title, movie_variant, language, format, attributes, screen_name,
      seat_layout_url, advertised_categories, is_current, status, next_capture_attempt_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,true,'scheduled',$10
    )
    ON CONFLICT (natural_key) DO UPDATE SET
      cutoff_at=EXCLUDED.cutoff_at, capture_at=EXCLUDED.capture_at,
      movie_title=EXCLUDED.movie_title, movie_variant=EXCLUDED.movie_variant,
      language=EXCLUDED.language, format=EXCLUDED.format, attributes=EXCLUDED.attributes,
      screen_name=EXCLUDED.screen_name, seat_layout_url=EXCLUDED.seat_layout_url,
      advertised_categories=EXCLUDED.advertised_categories, is_current=true,
      last_seen_at=now(), removed_at=NULL, updated_at=now()
    RETURNING *`,
    [
      show.naturalKey, show.slotKey, show.venueCode, show.showDate, show.showDateCode,
      show.showTimeCode, show.showTimeLabel, show.startAt, show.cutoffAt, show.captureAt,
      show.sessionId, show.eventCode, show.movieTitle, show.movieVariant, show.language,
      show.format, show.attributes, show.screenName, show.seatLayoutUrl,
      JSON.stringify(show.advertisedCategories)
    ]
  );
  return result.rows[0];
}

export async function reconcileDiscoveredShows(venue, dateCode, discoveredShows) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const showDate = `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}`;
    const existingResult = await client.query(
      `SELECT * FROM shows WHERE venue_code=$1 AND show_date=$2 AND is_current=true FOR UPDATE`,
      [venue.venueCode, showDate]
    );
    const changes = classifyScheduleChanges(existingResult.rows.map(dbShowToCore), discoveredShows);
    const insertedByKey = new Map();

    for (const discovered of discoveredShows) {
      const row = await insertOrUpdateShow(client, discovered);
      insertedByKey.set(discovered.naturalKey, row);
    }

    for (const change of changes.replaced) {
      const next = insertedByKey.get(change.next.naturalKey);
      await client.query(
        `UPDATE shows SET is_current=false, status='replaced', replaced_at=now(), updated_at=now() WHERE id=$1`,
        [change.previous.id]
      );
      await client.query(
        `INSERT INTO schedule_events (venue_code, show_date, slot_key, event_type, previous_show_id, next_show_id, details)
         VALUES ($1,$2,$3,'replaced',$4,$5,$6)`,
        [venue.venueCode, showDate, change.next.slotKey, change.previous.id, next.id,
          JSON.stringify({ previousNaturalKey: change.previous.naturalKey, nextNaturalKey: change.next.naturalKey })]
      );
    }

    for (const removed of changes.removed) {
      await client.query(
        `UPDATE shows SET is_current=false, status=CASE WHEN status='completed' THEN status ELSE 'removed' END,
         removed_at=now(), updated_at=now() WHERE id=$1`,
        [removed.id]
      );
      await client.query(
        `INSERT INTO schedule_events (venue_code, show_date, slot_key, event_type, previous_show_id)
         VALUES ($1,$2,$3,'removed',$4)`,
        [venue.venueCode, showDate, removed.slotKey, removed.id]
      );
    }

    for (const added of changes.added) {
      const next = insertedByKey.get(added.naturalKey);
      await client.query(
        `INSERT INTO schedule_events (venue_code, show_date, slot_key, event_type, next_show_id)
         VALUES ($1,$2,$3,'added',$4)`,
        [venue.venueCode, showDate, added.slotKey, next.id]
      );
    }

    await client.query("COMMIT");
    return { changes, rows: [...insertedByKey.values()] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function dueShows(now = new Date()) {
  const result = await pool.query(
    `SELECT * FROM shows
     WHERE is_current=true AND status IN ('scheduled','capturing')
       AND capture_at <= $1 AND cutoff_at > $1
       AND COALESCE(next_capture_attempt_at, capture_at) <= $1
     ORDER BY cutoff_at ASC`,
    [now]
  );
  return result.rows;
}

export async function captureWindowOpenOrSoon(now = new Date(), secondsAhead = 90) {
  const until = new Date(now.getTime() + secondsAhead * 1000);
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1 FROM shows
      WHERE is_current=true AND status IN ('scheduled','capturing')
        AND cutoff_at > $1
        AND COALESCE(next_capture_attempt_at, capture_at) <= $2
    ) AS imminent`,
    [now, until]
  );
  return result.rows[0].imminent;
}

export async function markCaptureFailed(showId, error, retryAt) {
  await pool.query(
    `UPDATE shows SET status='capturing', capture_attempts=capture_attempts+1,
     next_capture_attempt_at=$2, last_error=$3, updated_at=now() WHERE id=$1`,
    [showId, retryAt, String(error?.message || error).slice(0, 2000)]
  );
}

export async function saveSnapshot(show, snapshot, retryAt) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO snapshots (
        show_id, captured_at, capture_minute, source, capacity, available, sold,
        unknown, collection_paise, occupancy_percent, raw_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [show.id, snapshot.capturedAt, snapshot.captureMinute, snapshot.source, snapshot.capacity,
        snapshot.available, snapshot.sold, snapshot.unknown, snapshot.collectionPaise,
        snapshot.occupancyPercent, snapshot.rawHash]
    );
    for (const category of snapshot.categories) {
      await client.query(
        `INSERT INTO snapshot_categories (
          snapshot_id, name, list_price_paise, net_price_paise, capacity,
          available, sold, unknown, collection_paise
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [inserted.rows[0].id, category.name, category.listPricePaise, category.netPricePaise,
          category.capacity, category.available, category.sold, category.unknown,
          category.collectionPaise]
      );
    }
    await client.query(
      `UPDATE shows SET status='capturing', capture_attempts=capture_attempts+1,
       next_capture_attempt_at=$2, last_capture_at=$3, last_error=NULL, updated_at=now() WHERE id=$1`,
      [show.id, retryAt, snapshot.capturedAt]
    );
    await client.query("COMMIT");
    return inserted.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizeExpiredShows(now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const expired = await client.query(
      `SELECT * FROM shows WHERE is_current=true AND status IN ('scheduled','capturing') AND cutoff_at <= $1 FOR UPDATE`,
      [now]
    );
    for (const show of expired.rows) {
      const latest = await client.query(
        `SELECT id FROM snapshots WHERE show_id=$1 ORDER BY captured_at DESC LIMIT 1`,
        [show.id]
      );
      if (latest.rows[0]) {
        await client.query(`UPDATE snapshots SET is_final=true WHERE id=$1`, [latest.rows[0].id]);
        await client.query(`UPDATE shows SET status='completed', updated_at=now() WHERE id=$1`, [show.id]);
      } else {
        await client.query(
          `UPDATE shows SET status='missed', last_error=COALESCE(last_error,'No successful capture before cutoff'), updated_at=now() WHERE id=$1`,
          [show.id]
        );
      }
    }
    await client.query("COMMIT");
    return expired.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function startRun(run) {
  const result = await pool.query(
    `INSERT INTO collector_runs (run_type, venue_code, target_date, show_id, status, details)
     VALUES ($1,$2,$3,$4,'running',$5) RETURNING id`,
    [run.type, run.venueCode || null, run.targetDate || null, run.showId || null, JSON.stringify(run.details || {})]
  );
  return result.rows[0].id;
}

export async function finishRun(id, status, details = {}, error = null) {
  await pool.query(
    `UPDATE collector_runs SET status=$2, details=$3, error=$4, finished_at=now() WHERE id=$1`,
    [id, status, JSON.stringify(details), error ? String(error).slice(0, 4000) : null]
  );
}
