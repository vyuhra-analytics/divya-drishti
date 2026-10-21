// Continuous futures: a candle series that mixes contracts has a fake price jump at every roll.
// The stream records each roll with its gap (new contract price minus old at the roll); back-adjusting by those gaps
// shifts the older candles onto the current contract's level, so indicators see no jump. Pure and tested.
import type { Bar } from "./index";

export interface Roll {
  /** roll time, epoch seconds */
  at: number;
  /** new contract price minus old contract price at the roll */
  gap: number;
}

/**
 * Difference (Panama) back-adjustment: each bar moves by the sum of the gaps of every roll after it, so the latest
 * contract's prices stay exact. Volume is untouched. Prices can go negative far back if gaps pile up one way.
 */
export function adjustBackward(bars: Bar[], rolls: Roll[]): Bar[] {
  if (rolls.length === 0) return bars;
  const sorted = [...rolls].sort((a, b) => b.at - a.at); // newest first
  return bars.map((b) => {
    const shift = sorted.reduce((s, r) => (r.at > b.time ? s + r.gap : s), 0);
    return shift === 0 ? b : { ...b, open: b.open + shift, high: b.high + shift, low: b.low + shift, close: b.close + shift };
  });
}

/** Underlyings whose traded contract changed between two snapshots (both must have had one: a first sighting is not a roll). */
export function changedFronts(prev: Map<string, string>, next: Map<string, string>): { underlying: string; from: string; to: string }[] {
  const out: { underlying: string; from: string; to: string }[] = [];
  for (const [underlying, to] of next) {
    const from = prev.get(underlying);
    if (from && from !== to) out.push({ underlying, from, to });
  }
  return out;
}
