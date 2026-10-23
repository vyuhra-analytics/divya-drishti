-- The whole EIA reports, not only the headline table: every row of the nine petroleum tables and the gas file, with the year-ago and average
-- comparisons the files carry, in the file's own order. Adds columns to the 014 tables (see docs/redesign/EIA_REPORT_TRACKER.md).
ALTER TABLE eia_series ADD COLUMN IF NOT EXISTS table_id TEXT NOT NULL DEFAULT '';   -- T1..T9, '' for gas
ALTER TABLE eia_series ADD COLUMN IF NOT EXISTS grp      TEXT NOT NULL DEFAULT '';   -- the section of the table
ALTER TABLE eia_series ADD COLUMN IF NOT EXISTS parent   TEXT NOT NULL DEFAULT '';   -- the row a regional row belongs to

ALTER TABLE eia_report_values ADD COLUMN IF NOT EXISTS seq             INT;
ALTER TABLE eia_report_values ADD COLUMN IF NOT EXISTS year_ago        DOUBLE PRECISION;
ALTER TABLE eia_report_values ADD COLUMN IF NOT EXISTS year_ago_pct    DOUBLE PRECISION;
ALTER TABLE eia_report_values ADD COLUMN IF NOT EXISTS avg4            DOUBLE PRECISION;
ALTER TABLE eia_report_values ADD COLUMN IF NOT EXISTS avg4_year_ago   DOUBLE PRECISION;
ALTER TABLE eia_report_values ADD COLUMN IF NOT EXISTS five_year       DOUBLE PRECISION;
ALTER TABLE eia_report_values ADD COLUMN IF NOT EXISTS five_year_pct   DOUBLE PRECISION;

-- How quickly we had each report: the official release time (from the file's own header for gas, the scheduled time for petroleum) against the
-- moment our watcher first stored it.
CREATE TABLE IF NOT EXISTS eia_report_arrivals (
  event_id            BIGINT PRIMARY KEY REFERENCES economic_events (id) ON DELETE CASCADE,
  official_release_at TIMESTAMPTZ NOT NULL,
  first_stored_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  delay_ms            BIGINT NOT NULL,
  rows                INT NOT NULL,
  backfilled          BOOLEAN NOT NULL DEFAULT false  -- stored long after the release (a catch-up), so the delay says nothing about the watcher
);
ALTER TABLE eia_report_arrivals ADD COLUMN IF NOT EXISTS backfilled BOOLEAN NOT NULL DEFAULT false;
UPDATE eia_report_arrivals SET backfilled = true WHERE delay_ms > 1800000;
