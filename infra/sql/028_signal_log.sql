-- Every report-day and USIB evening, whether or not it was traded: the range, the candles after the print or the open, the signal or the reason there was none.
-- Written once by the API after the entry window has closed (the first evaluation wins; the row is never edited), so the history exists with the browser closed.
CREATE TABLE IF NOT EXISTS signal_log (
  key          TEXT        PRIMARY KEY,
  strategy     TEXT        NOT NULL,
  symbol       TEXT        NOT NULL,
  at           TIMESTAMPTZ NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT        NOT NULL,
  record       JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS signal_log_at ON signal_log (at DESC);
