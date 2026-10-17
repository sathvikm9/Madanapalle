UPDATE movie_releases SET
  release_date=first_tracked_date,
  source='manual-first-tracked',
  status='verified',
  next_retry_at=NULL,
  last_error=NULL,
  verified_at=CURRENT_TIMESTAMP,
  updated_at=CURRENT_TIMESTAMP
WHERE movie_key IN ('bethlehem kudumba unit', 'mirzapur: the movie');

PRAGMA optimize;
