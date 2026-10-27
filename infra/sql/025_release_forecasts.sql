-- Consensus forecasts for the weekly EIA and API releases, read from the event pages of Investing.com's economic calendar (third party, unofficial; see
-- shared investingCalendar.ts). One row per release of a series: the forecast, the previous and the actual as the page showed them, in million barrels.
-- A page holds about two years of history, so the first read backfills it. A forecast already on record is never replaced by an empty one (the page
-- drops the figure once the release is past), and `first_seen_at` says when we first saw the row.
CREATE TABLE IF NOT EXISTS release_forecasts (
  series        TEXT             NOT NULL,           -- eia_crude, eia_gasoline, eia_distillates, api_crude
  release_at    TIMESTAMPTZ      NOT NULL,           -- the scheduled release
  source        TEXT             NOT NULL DEFAULT 'investing.com',
  occurrence_id BIGINT,
  forecast      DOUBLE PRECISION,
  previous      DOUBLE PRECISION,
  actual        DOUBLE PRECISION,
  unit          TEXT,
  first_seen_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
  fetched_at    TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (series, release_at)
);
CREATE INDEX IF NOT EXISTS release_forecasts_fetched ON release_forecasts (series, fetched_at DESC);
