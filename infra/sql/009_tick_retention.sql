-- Tick retention. Raw ticks only feed the 1m continuous aggregate `bars_1m`, so they are dropped after 90 days (whole 7-day chunks, by a
-- daily Timescale job) while the 1m bars stay for good. To change the 90, edit it here and run `bun run db:migrate`: the policy is replaced.
--
-- The aggregate's refresh policy now covers ALL history (start_offset NULL) instead of the last hour: it only reprocesses ranges whose
-- ticks changed since the last refresh, so it costs nothing when idle, and it means ticks that arrive late or are restored from a backup
-- are folded into bars_1m before retention can drop them.
SELECT remove_continuous_aggregate_policy('bars_1m', if_exists => TRUE);
SELECT add_continuous_aggregate_policy('bars_1m',
  start_offset => NULL,
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

SELECT remove_retention_policy('ticks', if_exists => TRUE);
SELECT add_retention_policy('ticks', INTERVAL '90 days');
