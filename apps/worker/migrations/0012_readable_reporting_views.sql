-- Read-only reporting layer for Cloudflare D1 Studio and ad-hoc SQL.
--
-- The capture pipeline continues to write to the normalized operational tables.
-- People should query the report_* views below instead of joining shows,
-- snapshots, JSON price categories, and schedule events by hand.

CREATE INDEX IF NOT EXISTS shows_completed_report_idx
  ON shows (show_date, venue_code, movie_title COLLATE NOCASE, start_at)
  WHERE is_current=1 AND status='completed';

CREATE INDEX IF NOT EXISTS shows_movie_report_idx
  ON shows (movie_title, show_date, venue_code, start_at)
  WHERE is_current=1;

CREATE INDEX IF NOT EXISTS schedule_events_report_idx
  ON schedule_events (show_date, event_type, venue_code, observed_at DESC);

CREATE INDEX IF NOT EXISTS collector_runs_show_report_idx
  ON collector_runs (show_id, started_at DESC);

-- One preferred snapshot per show. This exactly matches the application rule:
-- live seat captures beat summary estimates, final-window captures beat backups,
-- and the latest capture wins within the same quality level.
CREATE VIEW IF NOT EXISTS report_best_snapshot AS
SELECT
  selected.id AS snapshot_id,
  shows.id AS show_id,
  selected.captured_at,
  selected.received_at,
  datetime(selected.captured_at, '+5 hours', '+30 minutes') AS captured_at_ist,
  selected.source,
  selected.capacity,
  selected.available AS available_seats,
  selected.sold AS tickets_sold,
  selected.unknown AS unknown_seats,
  ROUND(selected.collection_paise / 100.0, 2) AS gross_rupees,
  selected.occupancy_percent,
  selected.is_final,
  CASE
    WHEN selected.source LIKE '%summary-estimate%' THEN 'Estimate'
    WHEN julianday(selected.captured_at) >= julianday(shows.cutoff_at, '-1 minute') THEN 'Final'
    ELSE 'Backup'
  END AS capture_type,
  selected.categories_json
FROM shows
JOIN snapshots selected ON selected.id=(
  SELECT candidate.id
  FROM snapshots candidate
  WHERE candidate.show_id=shows.id
  ORDER BY
    (
      CASE WHEN candidate.source LIKE '%summary-estimate%' THEN 0 ELSE 4 END
      + CASE
          WHEN julianday(candidate.captured_at) >= julianday(shows.cutoff_at, '-1 minute')
            THEN 2
          ELSE 0
        END
    ) DESC,
    candidate.captured_at DESC,
    candidate.id DESC
  LIMIT 1
);

-- Main view: one readable row per active show.
CREATE VIEW IF NOT EXISTS report_show_results AS
SELECT
  shows.id AS show_id,
  shows.show_date,
  shows.show_time_label AS show_time,
  shows.venue_name AS theatre,
  shows.venue_code AS theatre_code,
  shows.movie_title AS movie,
  shows.language,
  shows.format,
  CASE shows.status
    WHEN 'completed' THEN 'Completed'
    WHEN 'capturing' THEN 'Capturing'
    WHEN 'missed' THEN 'Missed'
    ELSE 'Scheduled'
  END AS show_status,
  selected.sold AS tickets_sold,
  ROUND(selected.collection_paise / 100.0, 2) AS gross_rupees,
  selected.capacity,
  selected.available AS available_seats,
  selected.occupancy_percent,
  CASE
    WHEN selected.id IS NULL THEN 'Not captured'
    WHEN selected.source LIKE '%summary-estimate%' THEN 'Estimate'
    WHEN julianday(selected.captured_at) >= julianday(shows.cutoff_at, '-1 minute') THEN 'Final'
    ELSE 'Backup'
  END AS capture_type,
  selected.captured_at,
  datetime(selected.captured_at, '+5 hours', '+30 minutes') AS captured_at_ist,
  selected.source AS capture_source,
  shows.capture_attempts,
  shows.last_error
FROM shows
LEFT JOIN snapshots selected ON selected.id=(
  SELECT candidate.id
  FROM snapshots candidate
  WHERE candidate.show_id=shows.id
  ORDER BY
    (
      CASE WHEN candidate.source LIKE '%summary-estimate%' THEN 0 ELSE 4 END
      + CASE
          WHEN julianday(candidate.captured_at) >= julianday(shows.cutoff_at, '-1 minute')
            THEN 2
          ELSE 0
        END
    ) DESC,
    candidate.captured_at DESC,
    candidate.id DESC
  LIMIT 1
)
WHERE shows.is_current=1;

-- One row per ticket class, with prices already converted from paise to rupees.
CREATE VIEW IF NOT EXISTS report_price_breakdown AS
SELECT
  shows.id AS show_id,
  shows.show_date,
  shows.show_time_label AS show_time,
  shows.venue_name AS theatre,
  shows.movie_title AS movie,
  json_extract(category.value, '$.name') AS ticket_class,
  ROUND(json_extract(category.value, '$.listPricePaise') / 100.0, 2) AS listed_price_rupees,
  ROUND(json_extract(category.value, '$.netPricePaise') / 100.0, 2) AS adjusted_price_rupees,
  json_extract(category.value, '$.capacity') AS capacity,
  json_extract(category.value, '$.sold') AS tickets_sold,
  json_extract(category.value, '$.available') AS available_seats,
  ROUND(json_extract(category.value, '$.collectionPaise') / 100.0, 2) AS gross_rupees
FROM shows
JOIN snapshots selected ON selected.id=(
  SELECT candidate.id
  FROM snapshots candidate
  WHERE candidate.show_id=shows.id
  ORDER BY
    (
      CASE WHEN candidate.source LIKE '%summary-estimate%' THEN 0 ELSE 4 END
      + CASE
          WHEN julianday(candidate.captured_at) >= julianday(shows.cutoff_at, '-1 minute')
            THEN 2
          ELSE 0
        END
    ) DESC,
    candidate.captured_at DESC,
    candidate.id DESC
  LIMIT 1
)
JOIN json_each(selected.categories_json) category
WHERE shows.is_current=1;

-- Initial capture compared with the application's preferred final result.
CREATE VIEW IF NOT EXISTS report_capture_comparison AS
SELECT
  shows.id AS show_id,
  shows.show_date,
  shows.show_time_label AS show_time,
  shows.venue_name AS theatre,
  shows.movie_title AS movie,
  first_capture.captured_at AS initial_captured_at,
  first_capture.sold AS initial_tickets,
  ROUND(first_capture.collection_paise / 100.0, 2) AS initial_gross_rupees,
  final_capture.captured_at AS final_captured_at,
  CASE
    WHEN final_capture.id IS NULL THEN 'Not captured'
    WHEN final_capture.source LIKE '%summary-estimate%' THEN 'Estimate'
    WHEN julianday(final_capture.captured_at) >= julianday(shows.cutoff_at, '-1 minute') THEN 'Final'
    ELSE 'Backup'
  END AS final_capture_type,
  final_capture.sold AS final_tickets,
  ROUND(final_capture.collection_paise / 100.0, 2) AS final_gross_rupees,
  final_capture.sold - first_capture.sold AS ticket_difference,
  ROUND((final_capture.collection_paise - first_capture.collection_paise) / 100.0, 2)
    AS gross_difference_rupees
FROM shows
LEFT JOIN snapshots first_capture ON first_capture.id=(
  SELECT initial.id
  FROM snapshots initial
  WHERE initial.show_id=shows.id
  ORDER BY initial.captured_at ASC, initial.id ASC
  LIMIT 1
)
LEFT JOIN snapshots final_capture ON final_capture.id=(
  SELECT candidate.id
  FROM snapshots candidate
  WHERE candidate.show_id=shows.id
  ORDER BY
    (
      CASE WHEN candidate.source LIKE '%summary-estimate%' THEN 0 ELSE 4 END
      + CASE
          WHEN julianday(candidate.captured_at) >= julianday(shows.cutoff_at, '-1 minute')
            THEN 2
          ELSE 0
        END
    ) DESC,
    candidate.captured_at DESC,
    candidate.id DESC
  LIMIT 1
)
WHERE shows.is_current=1;

CREATE VIEW IF NOT EXISTS report_theatre_daily AS
SELECT
  show_date,
  theatre,
  theatre_code,
  COUNT(*) AS shows_captured,
  SUM(tickets_sold) AS tickets_sold,
  ROUND(SUM(gross_rupees), 2) AS gross_rupees,
  SUM(capacity) AS captured_seats,
  ROUND(100.0 * SUM(tickets_sold) / NULLIF(SUM(capacity), 0), 2) AS occupancy_percent,
  SUM(CASE WHEN tickets_sold >= capacity AND capacity > 0 THEN 1 ELSE 0 END) AS housefull_shows
FROM report_show_results
WHERE show_status='Completed' AND tickets_sold IS NOT NULL
GROUP BY show_date, theatre_code, theatre;

CREATE VIEW IF NOT EXISTS report_movie_daily AS
SELECT
  show_date,
  movie,
  COUNT(*) AS shows_captured,
  COUNT(DISTINCT theatre_code) AS theatres,
  SUM(tickets_sold) AS tickets_sold,
  ROUND(SUM(gross_rupees), 2) AS gross_rupees,
  SUM(capacity) AS captured_seats,
  ROUND(100.0 * SUM(tickets_sold) / NULLIF(SUM(capacity), 0), 2) AS occupancy_percent
FROM report_show_results
WHERE show_status='Completed' AND tickets_sold IS NOT NULL
GROUP BY show_date, movie;

CREATE VIEW IF NOT EXISTS report_theatre_totals AS
SELECT
  theatre,
  theatre_code,
  MIN(show_date) AS first_date,
  MAX(show_date) AS latest_date,
  COUNT(DISTINCT show_date) AS days_captured,
  SUM(shows_captured) AS shows_captured,
  SUM(tickets_sold) AS tickets_sold,
  ROUND(SUM(gross_rupees), 2) AS gross_rupees,
  ROUND(100.0 * SUM(tickets_sold) / NULLIF(SUM(captured_seats), 0), 2) AS occupancy_percent,
  SUM(housefull_shows) AS housefull_shows
FROM report_theatre_daily
GROUP BY theatre_code, theatre;

CREATE VIEW IF NOT EXISTS report_movie_totals AS
SELECT
  movie,
  MIN(show_date) AS first_show_date,
  MAX(show_date) AS last_show_date,
  COUNT(DISTINCT show_date) AS days_screened,
  SUM(shows_captured) AS shows_captured,
  SUM(tickets_sold) AS tickets_sold,
  ROUND(SUM(gross_rupees), 2) AS gross_rupees,
  ROUND(100.0 * SUM(tickets_sold) / NULLIF(SUM(captured_seats), 0), 2) AS occupancy_percent
FROM report_movie_daily
GROUP BY movie;

CREATE VIEW IF NOT EXISTS report_schedule_changes AS
SELECT
  events.id AS change_id,
  events.show_date,
  events.venue_code AS theatre_code,
  COALESCE(previous_show.venue_name, next_show.venue_name, events.venue_code) AS theatre,
  CASE events.event_type
    WHEN 'added' THEN 'Added'
    WHEN 'removed' THEN 'Removed'
    WHEN 'replaced' THEN 'Changed'
    ELSE events.event_type
  END AS change_type,
  previous_show.show_time_label AS previous_time,
  previous_show.movie_title AS previous_movie,
  next_show.show_time_label AS new_time,
  next_show.movie_title AS new_movie,
  events.observed_at,
  datetime(events.observed_at, '+5 hours', '+30 minutes') AS observed_at_ist
FROM schedule_events events
LEFT JOIN shows previous_show ON previous_show.id=events.previous_show_id
LEFT JOIN shows next_show ON next_show.id=events.next_show_id
WHERE events.event_type IN ('added', 'removed', 'replaced');

CREATE VIEW IF NOT EXISTS report_movie_releases AS
SELECT
  movie_title AS movie,
  first_tracked_date,
  release_date,
  CASE
    WHEN release_date IS NULL THEN 'Pending verification'
    WHEN release_date < first_tracked_date THEN 'Re-release'
    ELSE 'New release'
  END AS release_type,
  status AS verification_status,
  COALESCE(metadata_provider, source) AS verified_from,
  metadata_movie_url AS source_url,
  verified_at
FROM movie_releases;

PRAGMA optimize;
