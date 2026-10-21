// Bar and quote rules. Written down once, enforced at every ingest, so nothing impossible is stored and nothing is used before it formed.
//
// CONVENTION: `Bar.time` is the bar's OPEN, in epoch seconds (what providers and charts use). A bar closes at `time + timeframe seconds`
// and is only AVAILABLE then: any replay, backtest or briefing that reasons "as of now" must use `completedBars`, never the forming bar.
import type { Bar, Quote } from "./index";

/** Why a bar cannot be real, or undefined when it is consistent. */
export function barProblem(b: Bar): string | undefined {
  for (const k of ["open", "high", "low", "close"] as const) {
    if (!Number.isFinite(b[k])) return `${k} is not a number`;
    if (b[k] <= 0) return `${k} is not positive`;
  }
  if (!Number.isFinite(b.time) || !Number.isInteger(b.time) || b.time <= 0) return "time is not a whole number of epoch seconds";
  if (!Number.isFinite(b.volume) || b.volume < 0) return "volume is negative or not a number";
  if (b.high < Math.max(b.open, b.close, b.low)) return "high is below the open, close or low";
  if (b.low > Math.min(b.open, b.close, b.high)) return "low is above the open, close or high";
  return undefined;
}

export interface DroppedBar {
  time: number;
  reason: string;
}

/** Keep the consistent bars, report the rest. A bar we know is impossible is never stored or drawn. */
export function validateBars(bars: Bar[]): { bars: Bar[]; dropped: DroppedBar[] } {
  const kept: Bar[] = [];
  const dropped: DroppedBar[] = [];
  for (const b of bars) {
    const reason = barProblem(b);
    if (reason) dropped.push({ time: b.time, reason });
    else kept.push(b);
  }
  return { bars: kept, dropped };
}

/** Why a quote cannot be real, or undefined. Crossed bid/ask is allowed: depth snapshots cross for an instant. */
export function quoteProblem(q: Quote): string | undefined {
  if (!Number.isFinite(q.price) || q.price <= 0) return "price is not a positive number";
  if (!Number.isFinite(q.time) || q.time <= 0) return "time is not a number";
  if (q.volume !== undefined && (!Number.isFinite(q.volume) || q.volume < 0)) return "volume is negative or not a number";
  for (const k of ["bid", "ask", "open", "high", "low", "prevClose"] as const) {
    const v = q[k];
    if (v !== undefined && (!Number.isFinite(v) || v <= 0)) return `${k} is not a positive number`;
  }
  if (q.high !== undefined && q.low !== undefined && q.high < q.low) return "high is below low";
  return undefined;
}

/** The moment a bar's data is complete (epoch seconds). */
export const barCloseTime = (b: Bar, tfSeconds: number) => b.time + tfSeconds;

/** Bars that had closed by `nowSec`: drops the still-forming last bar so nothing is computed from a bar that has not finished. */
export function completedBars(bars: Bar[], tfSeconds: number, nowSec: number): Bar[] {
  return bars.filter((b) => barCloseTime(b, tfSeconds) <= nowSec);
}
