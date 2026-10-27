-- The market reaction to each EIA release, saved once its first hour is complete. It is worked out from one-minute candles, which the free feeds keep for
-- only a few sessions (Yahoo: five), so a release older than that could not be rebuilt: this keeps what the candles and our own feed recording showed.
-- The first complete copy wins and is never replaced (a later copy would be rebuilt from different, thinner data).
CREATE TABLE IF NOT EXISTS eia_release_reactions (
  report       TEXT        NOT NULL,                 -- WPSR or WNGSR
  week_ending  DATE        NOT NULL,
  key          TEXT        NOT NULL,                 -- cl, mcx_crude, ng, mcx_gas
  label        TEXT        NOT NULL,
  decimals     INTEGER     NOT NULL,
  reaction     JSONB       NOT NULL,                 -- shared Reaction
  micro        JSONB,                                -- shared Microstructure (MCX only, from our feed recording)
  saved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report, week_ending, key)
);
