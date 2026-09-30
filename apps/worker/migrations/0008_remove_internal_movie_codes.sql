DELETE FROM movie_releases
WHERE EXISTS (
  SELECT 1
  FROM shows
  WHERE lower(trim(shows.movie_title))=movie_releases.movie_key
    AND lower(trim(shows.event_code))=movie_releases.movie_key
);

PRAGMA optimize;
