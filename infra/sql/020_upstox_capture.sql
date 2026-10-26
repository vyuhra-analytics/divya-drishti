-- More of what Upstox sends, kept because none of it can be asked for after the session.
-- 1. feed_quotes: the last traded quantity (the real trade size), the order-book totals and the previous close; and a contract nobody has
--    traded yet still has a book, so `price` may be NULL (bid/ask/depth only).
ALTER TABLE feed_quotes ALTER COLUMN price DROP NOT NULL;
ALTER TABLE feed_quotes ADD COLUMN IF NOT EXISTS ltq DOUBLE PRECISION;
ALTER TABLE feed_quotes ADD COLUMN IF NOT EXISTS total_buy_qty DOUBLE PRECISION;
ALTER TABLE feed_quotes ADD COLUMN IF NOT EXISTS total_sell_qty DOUBLE PRECISION;
ALTER TABLE feed_quotes ADD COLUMN IF NOT EXISTS prev_close DOUBLE PRECISION;

-- 2. quote_snapshots: the whole chain, futures and options, every 15 minutes while MCX is open (and once after the close), from Upstox's REST
--    full quote + option greeks: the fields the live feed does not carry (circuit limits, OI day high/low, order counts per depth level).
CREATE TABLE IF NOT EXISTS quote_snapshots (
  time           TIMESTAMPTZ      NOT NULL,
  key            TEXT             NOT NULL,
  symbol         TEXT,
  last_price     DOUBLE PRECISION,
  last_trade_at  TIMESTAMPTZ,
  ltq            DOUBLE PRECISION,
  volume         DOUBLE PRECISION,
  average_price  DOUBLE PRECISION,
  oi             DOUBLE PRECISION,
  oi_day_high    DOUBLE PRECISION,
  oi_day_low     DOUBLE PRECISION,
  net_change     DOUBLE PRECISION,
  prev_close     DOUBLE PRECISION,
  open           DOUBLE PRECISION,
  high           DOUBLE PRECISION,
  low            DOUBLE PRECISION,
  close          DOUBLE PRECISION,
  total_buy_qty  DOUBLE PRECISION,
  total_sell_qty DOUBLE PRECISION,
  lower_circuit  DOUBLE PRECISION,
  upper_circuit  DOUBLE PRECISION,
  depth          JSONB,           -- {buy:[{quantity,price,orders}], sell:[...]}, five levels
  iv             DOUBLE PRECISION,
  delta          DOUBLE PRECISION,
  theta          DOUBLE PRECISION,
  gamma          DOUBLE PRECISION,
  vega           DOUBLE PRECISION
);
SELECT create_hypertable('quote_snapshots', 'time', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS quote_snapshots_key_time ON quote_snapshots (key, time DESC);
ALTER TABLE quote_snapshots SET (timescaledb.compress, timescaledb.compress_segmentby = 'key', timescaledb.compress_orderby = 'time DESC');
SELECT add_compression_policy('quote_snapshots', INTERVAL '3 days', if_not_exists => TRUE);
SELECT remove_retention_policy('quote_snapshots', if_exists => TRUE);
SELECT add_retention_policy('quote_snapshots', INTERVAL '365 days');

-- 3. contract_master: every contract of our underlyings that Upstox's daily instrument file has listed, with the first and last day we saw it,
--    so the strikes, expiries and lot sizes of a past day can be rebuilt. `raw` is the master row as published.
CREATE TABLE IF NOT EXISTS contract_master (
  key         TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,
  underlying  TEXT NOT NULL,
  kind        TEXT NOT NULL,         -- FUT, CE, PE
  expiry      DATE,
  strike      DOUBLE PRECISION,
  lot         DOUBLE PRECISION,
  tick        DOUBLE PRECISION,
  first_seen  DATE NOT NULL,
  last_seen   DATE NOT NULL,
  raw         JSONB
);
CREATE INDEX IF NOT EXISTS contract_master_chain ON contract_master (underlying, expiry, strike);

-- 4. market_log: every change of the exchange's own status (open, close, halts) as Upstox reports it, and market_days: each day's official
--    session times for every exchange.
CREATE TABLE IF NOT EXISTS market_log (
  time     TIMESTAMPTZ NOT NULL DEFAULT now(),
  exchange TEXT        NOT NULL,
  status   TEXT        NOT NULL
);
CREATE INDEX IF NOT EXISTS market_log_time ON market_log (exchange, time DESC);
CREATE TABLE IF NOT EXISTS market_days (
  day        DATE        NOT NULL,
  exchange   TEXT        NOT NULL,
  start_at   TIMESTAMPTZ,
  end_at     TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, exchange)
);
