// Session breaks: where the market was shut between two candles (the overnight close of MCX, the daily maintenance break of NYMEX, a weekend, a holiday).
// Found from the candles themselves, not from a rule table, so a holiday or an exchange's special hours show up as they happened. Pure and tested; the
// study that draws them is web advSessionBreaks.ts.

export interface SessionBreak {
  /** the end of the last candle before the break (epoch seconds) */
  closeAt: number;
  /** the open of the first candle after it */
  openAt: number;
  /** the length of the break in seconds */
  gapSec: number;
}

/** The candle length in seconds: the smallest gap between neighbouring candles. 0 without two candles. */
export function candleSeconds(bars: readonly { time: number }[]): number {
  let best = Infinity;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].time - bars[i - 1].time;
    if (d > 0 && d < best) best = d;
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * Every break of at least `minGapMin` minutes between consecutive candles (default 30). A chart of daily or longer candles has no breaks (every candle
 * is a session of its own), and a gap shorter than the threshold is a quiet market or a missing candle, not a close.
 */
export function sessionBreaks(bars: readonly { time: number }[], minGapMin = 30): SessionBreak[] {
  const tf = candleSeconds(bars);
  if (!tf || tf >= 86_400) return [];
  const min = Math.max(minGapMin * 60, tf * 2);
  const out: SessionBreak[] = [];
  for (let i = 1; i < bars.length; i++) {
    const closeAt = bars[i - 1].time + tf;
    const gap = bars[i].time - closeAt;
    if (gap >= min) out.push({ closeAt, openAt: bars[i].time, gapSec: gap });
  }
  return out;
}
