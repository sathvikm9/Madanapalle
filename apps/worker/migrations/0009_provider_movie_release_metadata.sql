ALTER TABLE movie_releases ADD COLUMN metadata_provider TEXT;
ALTER TABLE movie_releases ADD COLUMN metadata_event_code TEXT;
ALTER TABLE movie_releases ADD COLUMN metadata_movie_url TEXT;

UPDATE movie_releases SET
  metadata_provider='bookmyshow',
  metadata_event_code=bms_event_code,
  metadata_movie_url=bms_movie_url
WHERE bms_event_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS movie_releases_provider_pending_idx
  ON movie_releases (status, metadata_provider, next_retry_at, first_tracked_at DESC);

PRAGMA optimize;
