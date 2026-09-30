CREATE TABLE IF NOT EXISTS movie_releases (
  movie_key TEXT PRIMARY KEY,
  movie_title TEXT NOT NULL,
  bms_event_code TEXT,
  bms_movie_url TEXT,
  first_tracked_at TEXT NOT NULL,
  first_tracked_date TEXT NOT NULL,
  release_date TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_retry_at TEXT,
  last_error TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS movie_releases_pending_idx
  ON movie_releases (status, next_retry_at, first_tracked_at DESC);

INSERT OR IGNORE INTO movie_releases (
  movie_key, movie_title, bms_event_code, first_tracked_at, first_tracked_date,
  status, created_at, updated_at
)
SELECT
  lower(trim(movie_title)),
  movie_title,
  MAX(CASE WHEN upper(event_code) GLOB 'ET[0-9]*' THEN upper(event_code) END),
  MIN(start_at),
  MIN(show_date),
  'pending',
  MIN(created_at),
  MAX(updated_at)
FROM shows
WHERE lower(trim(movie_title)) NOT IN ('vishwanath and sons', 'awarapan 2', 'hushar pittalu')
GROUP BY lower(trim(movie_title));

UPDATE movie_releases SET
  release_date='2026-08-21', source='bookmyshow', status='verified',
  verified_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
WHERE movie_key='irumudi';

UPDATE movie_releases SET
  release_date='2026-09-24', source='bookmyshow', status='verified',
  verified_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
WHERE movie_key='the paradise';

UPDATE movie_releases SET
  release_date='2026-09-25', source='bookmyshow', status='verified',
  verified_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
WHERE movie_key='avengers endgame: encore';

UPDATE movie_releases SET
  release_date='2004-10-15', source='bookmyshow', status='verified',
  verified_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
WHERE movie_key='shankar dada mbbs';

UPDATE movie_releases SET
  release_date='2011-12-09', source='bookmyshow', status='verified',
  verified_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
WHERE movie_key='panjaa';

UPDATE movie_releases SET
  release_date='2024-09-27', source='bookmyshow', status='verified',
  verified_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
WHERE movie_key='devara - part 1';

PRAGMA optimize;
