-- Stored economic calendar. One dictionary row per KIND of event (event_series, seeded from code: packages/shared/src/eventSeries.ts), one row per
-- occurrence (economic_events), an append-only log of every figure ever seen for it (event_observations: forecast, previous, actual, revised, each with
-- its source and when we saw it, so a study can ask "what was known at time T"), and the full EIA report tables (eia_report_values) hanging off the
-- event. See docs/EVENTS.md.
CREATE TABLE IF NOT EXISTS event_series (
  code       TEXT PRIMARY KEY,                 -- WPSR, WNGSR, API, RIGS, MCX_HOLIDAY, FF:US:CORE_CPI_M_M, RBI_MPC_MINUTES...
  title      TEXT NOT NULL,
  category   TEXT NOT NULL,                    -- energy | macro | central_bank | holiday | data
  country    TEXT NOT NULL,
  importance TEXT NOT NULL,                    -- high | medium | low
  frequency  TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  relevance  TEXT[] NOT NULL DEFAULT '{}',     -- instrument tags: crude, gas, usdinr, mcx
  source     TEXT NOT NULL,
  schedule   JSONB NOT NULL,                   -- the rule from code, kept for reference
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS economic_events (
  id                     BIGSERIAL PRIMARY KEY,
  series_code            TEXT NOT NULL REFERENCES event_series (code),
  key                    TEXT NOT NULL,        -- natural key in the series: week-ending date for the weekly US reports, else the calendar date
  scheduled_at           TIMESTAMPTZ NOT NULL, -- latest known release time (a holiday can move it)
  original_scheduled_at  TIMESTAMPTZ NOT NULL, -- the time we first planned; never changes
  title                  TEXT NOT NULL,
  period                 TEXT,                 -- the week the figures cover
  status                 TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | released
  released_at            TIMESTAMPTZ,          -- when we first saw the actual
  first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (series_code, key)
);
CREATE INDEX IF NOT EXISTS economic_events_time ON economic_events (scheduled_at);

-- Append-only. A changed figure is a NEW row (same event and kind, different value), never an update, so the history of what was believed when stays.
CREATE TABLE IF NOT EXISTS event_observations (
  id          BIGSERIAL PRIMARY KEY,
  event_id    BIGINT NOT NULL REFERENCES economic_events (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                   -- forecast | previous | actual | revised
  value_text  TEXT NOT NULL,                   -- as published ("-4.6M")
  value_num   DOUBLE PRECISION,
  unit        TEXT,
  source      TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  backfilled  BOOLEAN NOT NULL DEFAULT false,  -- imported afterwards: observed_at is when it was loaded, not when it was known
  UNIQUE (event_id, kind, value_text, source)
);
CREATE INDEX IF NOT EXISTS event_observations_event ON event_observations (event_id, kind, observed_at);

CREATE TABLE IF NOT EXISTS eia_series (
  id       TEXT PRIMARY KEY,                   -- WPSR:COMMERCIAL_EXCLUDING_SPR, WNGSR:SOUTH_CENTRAL
  report   TEXT NOT NULL REFERENCES event_series (code),
  label    TEXT NOT NULL,
  unit     TEXT NOT NULL,
  headline BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS eia_report_values (
  event_id    BIGINT NOT NULL REFERENCES economic_events (id) ON DELETE CASCADE,
  series_id   TEXT NOT NULL REFERENCES eia_series (id),
  period_end  DATE NOT NULL,
  value       DOUBLE PRECISION NOT NULL,
  prior       DOUBLE PRECISION,
  change      DOUBLE PRECISION,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, series_id)
);
