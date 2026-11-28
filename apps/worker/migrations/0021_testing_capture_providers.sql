ALTER TABLE bms_testing_shows ADD COLUMN provider TEXT NOT NULL DEFAULT 'bookmyshow';
ALTER TABLE bms_testing_shows ADD COLUMN provider_url TEXT;

CREATE INDEX IF NOT EXISTS bms_testing_shows_provider_idx
  ON bms_testing_shows (provider, show_date, venue_code);
