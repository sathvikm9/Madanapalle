CREATE INDEX IF NOT EXISTS shows_movie_title_start_idx
  ON shows (movie_title COLLATE NOCASE, start_at);

