-- Idempotent: runs from Docker initdb and from `bun run db:migrate`.
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS ticks (
  time   TIMESTAMPTZ      NOT NULL,
  symbol TEXT             NOT NULL,
  price  DOUBLE PRECISION NOT NULL,
  size   DOUBLE PRECISION NOT NULL
);
SELECT create_hypertable('ticks', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS ticks_symbol_time ON ticks (symbol, time DESC);

-- 1m OHLCV computed by Timescale, not app code. Real-time aggregation on so the open bucket is visible.
CREATE MATERIALIZED VIEW IF NOT EXISTS bars_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket('1 minute', time) AS bucket,
       symbol,
       first(price, time) AS open,
       max(price)         AS high,
       min(price)         AS low,
       last(price, time)  AS close,
       sum(size)          AS volume
FROM ticks
GROUP BY bucket, symbol
WITH NO DATA;

-- The refresh policy for bars_1m lives in 009_tick_retention.sql (replaced on every run, so it cannot be added here too).
