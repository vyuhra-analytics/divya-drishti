-- Open interest per option contract per trading day (IST), recorded from the live chain: Upstox gives no previous-day OI for MCX options,
-- so OI change and "yesterday's OI" come from our own snapshots (first reading of the day, last reading of the day).
CREATE TABLE IF NOT EXISTS option_oi (
  day        DATE             NOT NULL,
  key        TEXT             NOT NULL,
  underlying TEXT             NOT NULL,
  expiry     DATE             NOT NULL,
  strike     DOUBLE PRECISION NOT NULL,
  side       TEXT             NOT NULL,
  first_oi   DOUBLE PRECISION NOT NULL,
  last_oi    DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (day, key)
);
CREATE INDEX IF NOT EXISTS option_oi_chain ON option_oi (underlying, expiry, day DESC);
