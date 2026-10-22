-- Open interest at the close of each candle, as Upstox sends it (futures and options); NULL for providers that do not (Yahoo) and for candles stored before this.
ALTER TABLE candles ADD COLUMN IF NOT EXISTS oi DOUBLE PRECISION;
