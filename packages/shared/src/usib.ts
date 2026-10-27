// USIB, the non-report-day strategy (docs/redesign/USER_AND_JOBS.md): the range of the hour before the US cash open, a 5-minute close beyond it with volume
// at least 1.5x the previous ten candles and price on the right side of session VWAP, one signal a day, entry at the next candle's open, R = 1.5 x ATR(14),
// stop 1R by touch, TP1 +1R then the stop to the entry, TP2 the next chain level (a round strike or an open-interest wall) at least 0.5R past TP1 or 2R, then a
// trail of 1 ATR under the best close, a time stop. The owner PARKED this strategy on 2026-10-22 with rule questions open (STRATEGY_REVIEW.md, B1 to B8), so
// every answer below that the owner did not give is a default, named in USIB_RULES and marked `?`, changeable in one place. Nothing here places an order. Pure and tested.
import type { Chain } from "./options";
import { zonedTime } from "./eventSeries";
import { atrAt, DAY_RULES, type DayBar, type DaySide } from "./reportDay";

export interface UsibBar extends DayBar {
  volume: number;
}

export const USIB_RULES = {
  /** the range is the hour before the US cash open (09:30 New York): 18:00 to 19:00 IST in summer, 19:00 to 20:00 after the clock change (? the owner did not say whether the range moves) */
  rangeMin: 60,
  /** a signal candle's volume against the average of the ten candles before it (owner) */
  volumeMult: 1.5,
  volumeWindow: 10,
  /** how long after the open a new signal is allowed: 60 minutes, 19:00 to 20:00 IST in summer (? from STRATEGY_REVIEW B7, a setting) */
  entryWindowMin: 60,
  /** TP2: the next chain level at least this many R beyond TP1, else this many R from the entry (owner: 0.5 and 2) */
  tp2MinR: 0.5,
  tp2DefaultR: 2,
  /** after TP2 the stop trails this many ATR under the best close (owner: "the best 5-minute close minus 1 ATR from TP2"; read as starting at TP2: ?) */
  trailAtr: 1,
  /** the time stop window after the US open: 150 to 180 minutes = 21:30 to 22:00 IST in summer, 22:30 to 23:00 after the clock change (owner) */
  timeStopFromMin: 150,
  timeStopToMin: 180,
} as const;

/** The US cash open (09:30 New York) that this evening's USIB belongs to: the latest one within the last 6 hours, else the next weekday's. Epoch ms. */
export function usOpenFor(now: number): number {
  const ny = (offsetDays: number) => {
    const d = new Date(now + offsetDays * 86_400_000);
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(d);
    const g = (t: string) => p.find((x) => x.type === t)!.value;
    return { y: Number(g("year")), m: Number(g("month")) - 1, d: Number(g("day")), wd: g("weekday") };
  };
  for (let i = -1; i <= 4; i++) {
    const n = ny(i);
    if (n.wd === "Sat" || n.wd === "Sun") continue;
    const at = zonedTime("America/New_York", n.y, n.m, n.d, 9, 30);
    if (at + 6 * 3600_000 > now) return at;
  }
  return now;
}

export type UsibStage = "wait" | "range" | "watch" | "after";

/** wait until the range hour, the range hour, the entry window after the open, then after it. */
export function usibStage(now: number, openAt: number): UsibStage {
  const d = (now - openAt) / 60_000;
  if (d < -USIB_RULES.rangeMin) return "wait";
  if (d < 0) return "range";
  if (d < USIB_RULES.entryWindowMin) return "watch";
  return "after";
}

export interface UsibRange {
  high: number;
  low: number;
  width: number;
  candles: number;
  complete: boolean;
}

/** The high and low of the hour before the open, from the candles that opened in it (the forming one included while the hour runs). */
export function usibRange(bars: readonly UsibBar[], openSec: number, nowSec: number): UsibRange | undefined {
  const from = openSec - USIB_RULES.rangeMin * 60;
  const inside = bars.filter((b) => b.time >= from && b.time < openSec && b.time <= nowSec);
  if (!inside.length) return undefined;
  const high = Math.max(...inside.map((b) => b.high));
  const low = Math.min(...inside.map((b) => b.low));
  return { high, low, width: high - low, candles: inside.length, complete: nowSec >= openSec };
}

const IST = 19_800;
/**
 * Session VWAP of each candle (typical price hlc3, weighted by volume), anchored at the first candle of the IST day (MCX opens at 09:00 IST). `?` the owner
 * said "session VWAP" without an anchor; the exchange day is the one our other VWAP uses. Null until a candle with volume.
 */
export function sessionVwap(bars: readonly UsibBar[]): (number | null)[] {
  const out: (number | null)[] = [];
  let day = -1;
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const d = Math.floor((b.time + IST) / 86_400);
    if (d !== day) {
      day = d;
      pv = 0;
      v = 0;
    }
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
    out.push(v > 0 ? pv / v : null);
  }
  return out;
}

export interface UsibCandle {
  time: number;
  close: number;
  complete: boolean;
  /** closed above or below the range, or inside */
  state: "inside" | "above" | "below";
  /** its volume as a multiple of the average of the ten candles before it, and whether that reaches 1.5 */
  volumeRatio?: number;
  volumeOk: boolean;
  /** the session VWAP at its close and whether the close is on the right side of it for a break that way */
  vwap?: number;
  vwapOk: boolean;
  /** a break that failed a filter, with the reason */
  filtered?: string;
}

export interface UsibSignal {
  side: DaySide;
  candleTime: number;
  closedAt: number;
  entry?: number;
  atr?: number;
  rPoints?: number;
  stop?: number;
  tp1?: number;
  tp2?: number;
  /** where TP2 came from: a chain level (and which) or the 2R default */
  tp2Source?: string;
  /** the trail distance once TP2 is reached, in points */
  trail?: number;
}

export interface UsibWatch {
  candles: UsibCandle[];
  signal?: UsibSignal;
  cutoffReached: boolean;
}

export interface ChainLevel {
  price: number;
  /** why it is a level: an open-interest wall, with the open interest, or a round strike */
  label: string;
}

/**
 * The levels TP2 can use: the open-interest walls (the strikes holding the most open interest on either side) and the round strikes (multiples of 100
 * for crude, 10 for gas, taken from the strikes that exist). A wall counts above the price for its calls and below it for its puts; to keep it plain, the
 * three highest-OI strikes of each side are walls and every strike that is a round number is a round level.
 */
export function chainLevels(chain: Chain | null | undefined): ChainLevel[] {
  if (!chain || !chain.rows.length) return [];
  const out = new Map<number, ChainLevel>();
  const round = chain.underlying.startsWith("NAT") ? 10 : 100;
  for (const r of chain.rows) if (r.strike % round === 0) out.set(r.strike, { price: r.strike, label: "round strike" });
  for (const side of ["ce", "pe"] as const) {
    const top = [...chain.rows].filter((r) => (r[side]?.oi ?? 0) > 0).sort((a, b) => (b[side]?.oi ?? 0) - (a[side]?.oi ?? 0)).slice(0, 3);
    for (const r of top) out.set(r.strike, { price: r.strike, label: `${side === "ce" ? "call" : "put"} OI wall ${(r[side]!.oi as number).toLocaleString("en-IN")}` });
  }
  return [...out.values()].sort((a, b) => a.price - b.price);
}

/** TP2: the first level beyond TP1 by at least `tp2MinR` x R, else the default of `tp2DefaultR` x R from the entry. */
export function pickTp2(side: DaySide, entry: number, rPoints: number, tp1: number, levels: readonly ChainLevel[]): { price: number; source: string } {
  const dir = side === "long" ? 1 : -1;
  const need = tp1 + dir * USIB_RULES.tp2MinR * rPoints;
  const beyond = levels.filter((l) => (dir === 1 ? l.price >= need : l.price <= need)).sort((a, b) => dir * (a.price - b.price));
  if (beyond[0]) return { price: beyond[0].price, source: beyond[0].label };
  return { price: entry + dir * USIB_RULES.tp2DefaultR * rPoints, source: `${USIB_RULES.tp2DefaultR}R (no level far enough)` };
}

/**
 * Watch the entry window after the open. A closed 5-minute candle that closes beyond the range is a break; it is a SIGNAL when its volume is at least
 * 1.5x the average of the ten candles before it and the close is on the right side of the session VWAP (above for a long, below for a short), and it
 * closed within the entry window. The first signal decides the day (one a day), a break that fails a filter is marked and does not use the day. The entry
 * is the next candle's open, R = 1.5 x ATR(14) at the signal candle, stop 1R, TP1 +1R, TP2 from the chain levels. Closed candles only.
 */
export function watchUsib(bars: readonly UsibBar[], openSec: number, range: UsibRange, levels: readonly ChainLevel[], nowSec: number): UsibWatch {
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  const vwap = sessionVwap(sorted);
  const cutoffAt = openSec + USIB_RULES.entryWindowMin * 60;
  const candles: UsibCandle[] = [];
  let signal: UsibSignal | undefined;
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    if (b.time < openSec || b.time >= cutoffAt) continue;
    const closedAt = b.time + DAY_RULES.candleSec;
    const complete = closedAt <= nowSec;
    const state = b.close > range.high ? "above" : b.close < range.low ? "below" : "inside";
    const prev = sorted.slice(Math.max(0, i - USIB_RULES.volumeWindow), i);
    const avg = prev.length === USIB_RULES.volumeWindow ? prev.reduce((a, x) => a + x.volume, 0) / prev.length : undefined;
    const volumeRatio = avg && avg > 0 ? b.volume / avg : undefined;
    const volumeOk = volumeRatio !== undefined && volumeRatio >= USIB_RULES.volumeMult;
    const v = vwap[i] ?? undefined;
    const side: DaySide | undefined = state === "above" ? "long" : state === "below" ? "short" : undefined;
    const vwapOk = v !== undefined && side !== undefined && (side === "long" ? b.close > v : b.close < v);
    const filtered = complete && side && !(volumeOk && vwapOk) ? [!volumeOk && `volume ${volumeRatio === undefined ? "n/a" : `${volumeRatio.toFixed(1)}x`} under ${USIB_RULES.volumeMult}x`, !vwapOk && `wrong side of VWAP`].filter(Boolean).join(", ") : undefined;
    candles.push({ time: b.time, close: b.close, complete, state, volumeRatio, volumeOk, vwap: v, vwapOk, filtered });
    if (!signal && complete && side && volumeOk && vwapOk && closedAt <= cutoffAt) {
      const atr = atrAt(sorted, i, DAY_RULES.atrPeriod);
      const next = sorted.find((x) => x.time === b.time + DAY_RULES.candleSec);
      const entry = next?.open;
      const rPoints = atr === undefined ? undefined : atr * DAY_RULES.atrMult;
      const dir = side === "long" ? 1 : -1;
      let extra: Partial<UsibSignal> = {};
      if (entry !== undefined && rPoints !== undefined) {
        const tp1 = entry + dir * rPoints;
        const tp2 = pickTp2(side, entry, rPoints, tp1, levels);
        extra = { stop: entry - dir * rPoints, tp1, tp2: tp2.price, tp2Source: tp2.source, trail: USIB_RULES.trailAtr * (atr as number) };
      }
      signal = { side, candleTime: b.time, closedAt, entry, atr, rPoints, ...extra };
    }
  }
  return { candles, signal, cutoffReached: nowSec >= cutoffAt };
}
