// Coarser candles from finer ones: the recorded option and futures history is one-minute candles, a panel may want five minutes or an hour.
import { bucketStart, type Bar } from "./index";

/**
 * Groups candles into `tfSeconds` buckets (boundaries in the exchange's time via `offsetSec`, as for provider history): open of the first, high of the
 * highest, low of the lowest, close of the last, volume summed, and open interest taken from the last candle (a level, never summed).
 * The input must be oldest first; a bucket holds only the candles that exist, so a thin contract gives a thin bucket.
 */
export function resampleBars(bars: Bar[], tfSeconds: number, offsetSec = 0): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const t = bucketStart(b.time, tfSeconds, offsetSec);
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
      if (b.oi !== undefined) last.oi = b.oi;
    } else out.push({ ...b, time: t });
  }
  return out;
}
