// Fair value gaps (ICT): three candles where the first and third do not overlap, leaving a hole the middle candle ran through.
// Bullish: low[i] > high[i-2] (gap = high[i-2]..low[i]). Bearish: high[i] < low[i-2] (gap = high[i]..low[i-2]).
// Causal: a gap is known only when candle i closes, and its mitigation only when a later candle trades back in; later bars never change an earlier result.

export interface FvgBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type FvgMitigation = "touch" | "mid" | "full";

export interface Fvg {
  dir: "bull" | "bear";
  top: number;
  bottom: number;
  /** index of the middle candle (where a box starts) */
  start: number;
  /** index of the candle whose close completed the pattern */
  formed: number;
  /** index of the first candle that traded back into the gap far enough (per the mode); undefined while the gap is open */
  mitigated?: number;
}

export interface FvgOptions {
  /** smallest gap as a multiple of ATR (mean true range of the last `atrPeriod` candles up to the completing one); 0 = every gap */
  minSizeAtr?: number;
  atrPeriod?: number;
  /** touch = any trade into the gap, mid = through the midpoint, full = through the far edge */
  mitigation?: FvgMitigation;
}

function atrAt(bars: readonly FvgBar[], i: number, period: number): number {
  const from = Math.max(1, i - period + 1);
  let sum = 0;
  let n = 0;
  for (let k = from; k <= i; k++) {
    sum += Math.max(bars[k].high - bars[k].low, Math.abs(bars[k].high - bars[k - 1].close), Math.abs(bars[k].low - bars[k - 1].close));
    n++;
  }
  return n ? sum / n : 0;
}

export function findFvgs(bars: readonly FvgBar[], opts: FvgOptions = {}): Fvg[] {
  const { minSizeAtr = 0, atrPeriod = 14, mitigation = "touch" } = opts;
  const out: Fvg[] = [];
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2];
    const c = bars[i];
    const bull = c.low > a.high;
    const bear = c.high < a.low;
    if (!bull && !bear) continue;
    const top = bull ? c.low : a.low;
    const bottom = bull ? a.high : c.high;
    if (minSizeAtr > 0 && top - bottom < minSizeAtr * atrAt(bars, i, atrPeriod)) continue;
    const gap: Fvg = { dir: bull ? "bull" : "bear", top, bottom, start: i - 1, formed: i };
    const level = mitigation === "touch" ? (bull ? top : bottom) : mitigation === "mid" ? (top + bottom) / 2 : bull ? bottom : top;
    for (let j = i + 1; j < bars.length; j++) {
      if (bull ? bars[j].low <= level : bars[j].high >= level) {
        gap.mitigated = j;
        break;
      }
    }
    out.push(gap);
  }
  return out;
}
