-- One-minute bars from outside providers, kept apart from our own `candles` (different instruments: Dukascopy CFDs are not the MCX or NYMEX contracts).
-- time = the bar's open, UTC. Append-only; volume is the provider's own measure (Dukascopy: tick volume, only a relative activity gauge).
CREATE TABLE IF NOT EXISTS external_bars (
  source TEXT             NOT NULL,                  -- dukascopy
  symbol TEXT             NOT NULL,                  -- the provider's code, e.g. lightcmdusd
  time   TIMESTAMPTZ      NOT NULL,
  open   DOUBLE PRECISION NOT NULL,
  high   DOUBLE PRECISION NOT NULL,
  low    DOUBLE PRECISION NOT NULL,
  close  DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION,
  PRIMARY KEY (source, symbol, time)
);
SELECT create_hypertable('external_bars', 'time', chunk_time_interval => INTERVAL '90 days', if_not_exists => TRUE);
