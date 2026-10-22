-- Briefings written by an agent (Claude over MCP) and submitted to the app, with how each point held up against the data.
CREATE TABLE IF NOT EXISTS briefings (
  id         TEXT             PRIMARY KEY,
  symbol     TEXT             NOT NULL,
  at         TIMESTAMPTZ      NOT NULL DEFAULT now(),
  source     TEXT             NOT NULL,
  price_then DOUBLE PRECISION NOT NULL,
  result     JSONB            NOT NULL,
  grounding  JSONB            NOT NULL
);
CREATE INDEX IF NOT EXISTS briefings_at ON briefings (at DESC);
