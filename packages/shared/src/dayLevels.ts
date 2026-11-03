// The high and low of the trading day (session) so far and of the day before, as levels that start where their day starts. Days are found from the candles
// (a break of at least `minGapMin` minutes, as sessionBreaks.ts), so the MCX overnight close, the NYMEX daily break, weekends and holidays split days as they
// happened. Pure and tested; the study that draws them is the killzones study (web advKillzones.ts).

import { barSeconds } from "./sessionZones";
import { sessionBreaks } from "./sessionBreaks";

export interface SessionDayBar {
  time: number;
  high: number;
  low: number;
}

export interface SessionDayRange {
  /** open of the day's first candle, and the end of its last one (epoch seconds) */
  from: number;
  to: number;
  high: number;
  low: number;
}

export interface DayLevels {
  /** the day of the newest candle: its high and low so far */
  today: SessionDayRange;
  /** the day before it (complete) */
  previous: SessionDayRange;
}

/**
 * Today's and the previous day's range. The first day in the data is never used: the chart may have loaded it half way, and a wrong high or low
 * would be a false level, so at least three days must be loaded (the first, the previous, today). Undefined on a chart of daily or longer candles.
 */
export function dayLevels(bars: readonly SessionDayBar[], minGapMin = 30): DayLevels | undefined {
  const tf = barSeconds(bars);
  if (bars.length < 3 || !tf || tf >= 86_400) return undefined;
  const breaks = sessionBreaks(bars, minGapMin);
  const starts = [0, ...breaks.map((b) => bars.findIndex((x) => x.time === b.openAt))];
  if (starts.length < 3 || starts.some((s) => s < 0)) return undefined;
  const range = (s: number, e: number): SessionDayRange => {
    let high = -Infinity;
    let low = Infinity;
    for (let i = s; i < e; i++) {
      high = Math.max(high, bars[i].high);
      low = Math.min(low, bars[i].low);
    }
    return { from: bars[s].time, to: bars[e - 1].time + tf, high, low };
  };
  const k = starts.length - 1;
  return { today: range(starts[k], bars.length), previous: range(starts[k - 1], starts[k]) };
}
