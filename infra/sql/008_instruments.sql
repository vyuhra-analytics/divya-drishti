-- Instruments the user added in Settings → Instruments (the six built-in futures live in code). Owned by the stream service;
-- the API re-reads the list from the stream every 30 s.
CREATE TABLE IF NOT EXISTS custom_instruments (
  symbol     TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
