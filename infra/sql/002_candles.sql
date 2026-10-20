-- Provider history (Yahoo / Upstox) written through by drishti-core-api, so charts still open when a provider is down.
CREATE TABLE IF NOT EXISTS candles (
  symbol TEXT             NOT NULL,
  tf     TEXT             NOT NULL,
  time   TIMESTAMPTZ      NOT NULL,
  open   DOUBLE PRECISION NOT NULL,
  high   DOUBLE PRECISION NOT NULL,
  low    DOUBLE PRECISION NOT NULL,
  close  DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (symbol, tf, time)
);
SELECT create_hypertable('candles', 'time', if_not_exists => TRUE);
