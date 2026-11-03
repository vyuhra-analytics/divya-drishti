// Pivot levels: fixed for a whole session, computed from the PREVIOUS session's high, low and close (so they are known before the session opens and never
// change inside it, whatever the chart's candle length). Sessions are found from the candles (a break of at least `minGapMin` minutes, as sessionBreaks.ts),
// so the MCX overnight close, the NYMEX daily break, weekends and holidays all split sessions as they happened. Pure and tested; the study is web advPivots.ts.

import { sessionBreaks } from "./sessionBreaks";

export type PivotVariant = "classic" | "fibonacci" | "camarilla";

export interface PivotBar {
  time: number;
  high: number;
  low: number;
  close: number;
}

/** level name to price: P, R1..R3, S1..S3 (camarilla also R4 and S4) */
export type PivotLevels = Record<string, number>;

/** The levels from one session's high, low and close. */
export function pivotLevels(high: number, low: number, close: number, variant: PivotVariant = "classic"): PivotLevels {
  const p = (high + low + close) / 3;
  const r = high - low;
  if (variant === "fibonacci") return { P: p, R1: p + 0.382 * r, R2: p + 0.618 * r, R3: p + r, S1: p - 0.382 * r, S2: p - 0.618 * r, S3: p - r };
  if (variant === "camarilla") {
    const k = 1.1 * r;
    return { P: p, R1: close + k / 12, R2: close + k / 6, R3: close + k / 4, R4: close + k / 2, S1: close - k / 12, S2: close - k / 6, S3: close - k / 4, S4: close - k / 2 };
  }
  return { P: p, R1: 2 * p - low, R2: p + r, R3: high + 2 * (p - low), S1: 2 * p - high, S2: p - r, S3: low - 2 * (high - p) };
}

export interface SessionPivots {
  /** open of the session's first candle and of its last candle (epoch seconds) */
  from: number;
  to: number;
  /** the previous session's high, low and close these levels come from */
  source: { high: number; low: number; close: number };
  levels: PivotLevels;
}

/**
 * Pivot levels for every session that has a complete session before it. The first session in the data is never used as a source: the chart may have
 * loaded it half way, and a wrong high or low would give wrong levels (so the first two sessions draw nothing). None on a chart of daily or longer
 * candles, where every candle is a session.
 */
export function sessionPivots(bars: readonly PivotBar[], variant: PivotVariant = "classic", minGapMin = 30): SessionPivots[] {
  if (bars.length < 2) return [];
  const breaks = sessionBreaks(bars, minGapMin);
  if (!breaks.length) return [];
  const starts = [0, ...breaks.map((b) => bars.findIndex((x) => x.time === b.openAt))];
  if (starts.some((s) => s < 0)) return [];
  const runs = starts.map((s, i) => ({ s, e: (i + 1 < starts.length ? starts[i + 1] : bars.length) - 1 }));
  const out: SessionPivots[] = [];
  for (let k = 2; k < runs.length; k++) {
    const src = runs[k - 1];
    let high = -Infinity;
    let low = Infinity;
    for (let i = src.s; i <= src.e; i++) {
      high = Math.max(high, bars[i].high);
      low = Math.min(low, bars[i].low);
    }
    const close = bars[src.e].close;
    out.push({ from: bars[runs[k].s].time, to: bars[runs[k].e].time, source: { high, low, close }, levels: pivotLevels(high, low, close, variant) });
  }
  return out;
}
