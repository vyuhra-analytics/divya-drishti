-- One-minute candles (with open interest) of the option contracts we record, copied from Upstox while a contract is live: Upstox serves
-- them for live contracts only, and its expired-contract API does not cover MCX, so this is the only way to keep option price history.
-- Append-only: rows are never updated or deleted by db:clean. See docs/redesign/UPSTOX_PLAN.md (spec 3).
CREATE TABLE IF NOT EXISTS option_contracts (
  key        TEXT             PRIMARY KEY,           -- Upstox instrument key, e.g. MCX_FO|582939
  symbol     TEXT             NOT NULL,              -- CRUDEOIL 9450 CE 17 NOV 26
  underlying TEXT             NOT NULL,
  expiry     DATE             NOT NULL,
  strike     DOUBLE PRECISION NOT NULL,
  side       TEXT             NOT NULL,              -- CE or PE
  lot        DOUBLE PRECISION,
  first_seen TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS option_contracts_chain ON option_contracts (underlying, expiry, strike);

CREATE TABLE IF NOT EXISTS option_candles (
  key    TEXT             NOT NULL REFERENCES option_contracts (key),
  time   TIMESTAMPTZ      NOT NULL,                  -- the candle's open
  open   DOUBLE PRECISION NOT NULL,
  high   DOUBLE PRECISION NOT NULL,
  low    DOUBLE PRECISION NOT NULL,
  close  DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL,
  oi     DOUBLE PRECISION,
  PRIMARY KEY (key, time)
);
SELECT create_hypertable('option_candles', 'time', if_not_exists => TRUE);
