-- Verified from District's raw movie metadata. The rendered date can shift on
-- non-India laptops, so this intentionally stores the source YYYY-MM-DD value.
UPDATE movie_releases SET
  metadata_provider='district',
  metadata_event_code='MV228227',
  metadata_movie_url='https://www.district.in/movies/don-t-trouble-the-trouble-movie-tickets-MV228227',
  release_date='2026-10-02',
  source='district',
  status='verified',
  next_retry_at=NULL,
  last_error=NULL,
  verified_at=CURRENT_TIMESTAMP,
  updated_at=CURRENT_TIMESTAMP
WHERE movie_key='don''t trouble the trouble';

PRAGMA optimize;
