-- NYMEX CL hourly bars (Yahoo CL=F, the longest history Yahoo gives: 730 days) for the headline sentiment study (research/sentiment, deviation D2).
-- Kept apart from `candles`: this is a spliced continuous series with roll jumps, fit only for the study, which drops windows that touch a roll.
CREATE TABLE IF NOT EXISTS cl_hourly (
  time   TIMESTAMPTZ PRIMARY KEY,   -- the bar's open
  open   DOUBLE PRECISION NOT NULL,
  high   DOUBLE PRECISION NOT NULL,
  low    DOUBLE PRECISION NOT NULL,
  close  DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL DEFAULT 0
);
