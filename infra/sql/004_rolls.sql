-- MCX front-month rolls, recorded by the stream when the traded contract changes: gap = new contract price minus old at the roll.
-- Used to back-adjust stored candles (which mix contracts) into a continuous series.
CREATE TABLE IF NOT EXISTS rolls (
  symbol        TEXT             NOT NULL,
  at            TIMESTAMPTZ      NOT NULL,
  from_contract TEXT             NOT NULL,
  to_contract   TEXT             NOT NULL,
  gap           DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (symbol, at)
);
