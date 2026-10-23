-- Crude-oil headlines from GDELT's 15-minute GKG files, for the sentiment study (research/sentiment, deviation D1). Not the app's news archive: kept apart so
-- the study's event set is exactly what the fixed relevance rule produced, with GDELT's own batch time as the clock. GDELT is free and open and must be credited.
CREATE TABLE IF NOT EXISTS gdelt_headlines (
  key     TEXT PRIMARY KEY,           -- normalised title: the first batch holding it is the event
  seen_at TIMESTAMPTZ NOT NULL,       -- the GDELT batch time (when GDELT processed the article), 15-minute resolution
  source  TEXT NOT NULL,
  url     TEXT NOT NULL,
  title   TEXT NOT NULL,
  themes  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS gdelt_headlines_seen ON gdelt_headlines (seen_at);

-- Which batches were read, so a run can stop and resume and a gap is visible.
CREATE TABLE IF NOT EXISTS gdelt_batches (
  batch_at   TIMESTAMPTZ PRIMARY KEY,
  status     TEXT NOT NULL,           -- ok | missing (GDELT has no such file) | failed (try again)
  rows_total INT NOT NULL DEFAULT 0,
  kept       INT NOT NULL DEFAULT 0,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
