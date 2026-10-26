-- One row per minute the stream was running: how many Upstox feed messages arrived in it and how many rows the recorder stored. A minute with
-- no row (or with no messages) while MCX was open is a hole in the recording; `GET /feed/coverage` lists them. Small: about 900 rows a day.
CREATE TABLE IF NOT EXISTS feed_minutes (
  minute        TIMESTAMPTZ PRIMARY KEY,
  upstox_msgs   INTEGER NOT NULL DEFAULT 0,
  rows_recorded INTEGER NOT NULL DEFAULT 0,
  failed_inserts INTEGER NOT NULL DEFAULT 0
);
