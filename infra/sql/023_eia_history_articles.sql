-- 1. eia_history: weekly history of the series an EIA release article sets in context (crude and product stocks, Cushing, the SPR, refinery runs,
--    utilisation, imports, exports, production, product supplied, Lower 48 and regional gas storage), loaded from EIA's Open Data API v2 in EIA's own
--    unit (stocks in thousand barrels). The report files carry only the latest week, so trend, streaks and the five-year range come from here.
CREATE TABLE IF NOT EXISTS eia_history (
  series     TEXT             NOT NULL,           -- EIA's id, e.g. WCESTUS1
  period     DATE             NOT NULL,           -- the week ending (a Friday)
  value      DOUBLE PRECISION NOT NULL,
  fetched_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (series, period)
);

-- 2. eia_articles: release articles. `source` is `template` (written by our own rules) or `claude-mcp` (written by Claude over MCP and checked by
--    code against the facts it was given); `grounding` holds the verdict per paragraph. Append-only: a corrected article is a new row.
CREATE TABLE IF NOT EXISTS eia_articles (
  id          TEXT PRIMARY KEY,
  report      TEXT        NOT NULL,                -- WPSR or WNGSR
  week_ending DATE        NOT NULL,
  source      TEXT        NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  article     JSONB       NOT NULL,
  grounding   JSONB
);
CREATE INDEX IF NOT EXISTS eia_articles_week ON eia_articles (report, week_ending, at DESC);
