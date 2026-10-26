-- The feed recorder's table: every change of a futures quote and of the option contracts near the money, as Upstox sent it, because Upstox serves
-- none of this after the session (no bid/ask history, no depth, no per-contract greeks). One table, keyed by our symbol (futures) or the Upstox
-- instrument key (options). `time` is when WE received it, `trade_at` the exchange's last-trade time. Chunks of a day, compressed after two days
-- (segmented by key), dropped after 180 days. To change either number edit it here and run `bun run db:migrate`.
CREATE TABLE IF NOT EXISTS feed_quotes (
  time      TIMESTAMPTZ      NOT NULL,
  key       TEXT             NOT NULL,
  trade_at  TIMESTAMPTZ,
  price     DOUBLE PRECISION NOT NULL,
  volume    DOUBLE PRECISION,
  bid       DOUBLE PRECISION,
  ask       DOUBLE PRECISION,
  bid_qty   DOUBLE PRECISION,
  ask_qty   DOUBLE PRECISION,
  oi        DOUBLE PRECISION,
  atp       DOUBLE PRECISION,
  depth     JSONB,
  iv        DOUBLE PRECISION,
  delta     DOUBLE PRECISION,
  theta     DOUBLE PRECISION,
  gamma     DOUBLE PRECISION,
  vega      DOUBLE PRECISION,
  rho       DOUBLE PRECISION
);
SELECT create_hypertable('feed_quotes', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS feed_quotes_key_time ON feed_quotes (key, time DESC);

ALTER TABLE feed_quotes SET (timescaledb.compress, timescaledb.compress_segmentby = 'key', timescaledb.compress_orderby = 'time DESC');
SELECT add_compression_policy('feed_quotes', INTERVAL '2 days', if_not_exists => TRUE);
SELECT remove_retention_policy('feed_quotes', if_exists => TRUE);
SELECT add_retention_policy('feed_quotes', INTERVAL '180 days');
