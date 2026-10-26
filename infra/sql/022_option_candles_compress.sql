-- The candle recorder now copies the whole chain of four underlyings every session, so option_candles grows by hundreds of thousands of rows a day.
-- Chunks older than a week are compressed, segmented by contract; nothing is ever dropped (this is the only history MCX options will ever have).
ALTER TABLE option_candles SET (timescaledb.compress, timescaledb.compress_segmentby = 'key', timescaledb.compress_orderby = 'time DESC');
SELECT add_compression_policy('option_candles', INTERVAL '7 days', if_not_exists => TRUE);
