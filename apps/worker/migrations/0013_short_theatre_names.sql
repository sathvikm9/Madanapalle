-- Keep the human-facing reports consistent with the names used by the website.

DROP VIEW IF EXISTS report_show_results;

CREATE VIEW report_show_results AS
SELECT
  shows.id AS show_id,
  shows.show_date,
  shows.show_time_label AS show_time,
  CASE shows.venue_code
    WHEN 'SKMD' THEN 'Sri Krishna'
    WHEN 'SCM' THEN 'Sai Chitra'
    WHEN 'RTDM' THEN 'Ravi'
    WHEN 'ASRM' THEN 'ASR'
    ELSE shows.venue_name
  END AS theatre,
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

DROP VIEW IF EXISTS report_price_breakdown;

CREATE VIEW report_price_breakdown AS
SELECT
  shows.id AS show_id,
  shows.show_date,
  shows.show_time_label AS show_time,
  CASE shows.venue_code
    WHEN 'SKMD' THEN 'Sri Krishna'
    WHEN 'SCM' THEN 'Sai Chitra'
    WHEN 'RTDM' THEN 'Ravi'
    WHEN 'ASRM' THEN 'ASR'
    ELSE shows.venue_name
  END AS theatre,
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

DROP VIEW IF EXISTS report_capture_comparison;

CREATE VIEW report_capture_comparison AS
SELECT
  shows.id AS show_id,
  shows.show_date,
  shows.show_time_label AS show_time,
  CASE shows.venue_code
    WHEN 'SKMD' THEN 'Sri Krishna'
    WHEN 'SCM' THEN 'Sai Chitra'
    WHEN 'RTDM' THEN 'Ravi'
    WHEN 'ASRM' THEN 'ASR'
    ELSE shows.venue_name
  END AS theatre,
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

DROP VIEW IF EXISTS report_schedule_changes;

CREATE VIEW report_schedule_changes AS
SELECT
  events.id AS change_id,
  events.show_date,
  events.venue_code AS theatre_code,
  CASE events.venue_code
    WHEN 'SKMD' THEN 'Sri Krishna'
    WHEN 'SCM' THEN 'Sai Chitra'
    WHEN 'RTDM' THEN 'Ravi'
    WHEN 'ASRM' THEN 'ASR'
    ELSE COALESCE(previous_show.venue_name, next_show.venue_name, events.venue_code)
  END AS theatre,
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

PRAGMA optimize;
