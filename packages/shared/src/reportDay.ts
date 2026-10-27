// The EIA report-day screen's logic (docs/redesign/EIA_STRATEGY.md and EIA_SCREENS.md): which stage the day is in, the range of the last hour before the
// print, the window after it (each 5-minute candle inside / closed above / closed below, and the first close that gives an entry), the levels from R, and
// the option strike to buy. Everything is decided from CLOSED candles and the numbers on screen; nothing here places an order. Pure and tested.
import type { Chain, ChainRow, OptionLeg } from "./options";

export type ReportCode = "WPSR" | "WNGSR";

/** What each report trades: crude options on the petroleum report, NATGASMINI options on the gas report, and the surprise that allows a side. */
export const REPORT_DAY: Record<ReportCode, { underlying: "CRUDEOIL" | "NATGASMINI"; symbol: string; threshold: number; unit: "MB" | "Bcf" }> = {
  WPSR: { underlying: "CRUDEOIL", symbol: "MCX:CRUDEOIL", threshold: 3, unit: "MB" },
  WNGSR: { underlying: "NATGASMINI", symbol: "MCX:NATGASMINI", threshold: 5, unit: "Bcf" },
};

/** The owner's numbers: the capital the option must fit, the loss cap of one trade, how long after the print a new entry is still allowed. */
export const DAY_RULES = { capital: 70_000, lossCap: 2_000, cutoffMin: 30, rangeMin: 60, atrPeriod: 14, atrMult: 1.5, candleSec: 300 } as const;

export type DayStage = "prep" | "range" | "print" | "window" | "after";

/**
 * The stage at `now` (epoch ms) for a release at `releaseAt`: prep until the range hour starts, range for the hour before the print, print for the first
 * two minutes (the number arrives), window until the entry cut-off, after that. The in-trade and done stages are the trader's own and are not here.
 */
export function dayStage(now: number, releaseAt: number, cutoffMin: number = DAY_RULES.cutoffMin): DayStage {
  const d = (now - releaseAt) / 60_000;
  if (d < -DAY_RULES.rangeMin) return "prep";
  if (d < 0) return "range";
  if (d < 2) return "print";
  if (d < cutoffMin) return "window";
  return "after";
}

export interface DayBar {
  /** the candle's OPEN in epoch seconds */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DayRange {
  high: number;
  low: number;
  width: number;
  /** candles in it, and whether the whole hour is covered (the hour is over and the first candle of it is there) */
  candles: number;
  complete: boolean;
}

/** The high and low of the last hour before the print (epoch seconds), from the candles that opened in it, the forming one included while the hour runs. */
export function preReleaseRange(bars: readonly DayBar[], releaseSec: number, nowSec: number): DayRange | undefined {
  const from = releaseSec - DAY_RULES.rangeMin * 60;
  const inside = bars.filter((b) => b.time >= from && b.time < releaseSec && b.time <= nowSec);
  if (!inside.length) return undefined;
  const high = Math.max(...inside.map((b) => b.high));
  const low = Math.min(...inside.map((b) => b.low));
  const first = Math.min(...inside.map((b) => b.time));
  return { high, low, width: high - low, candles: inside.length, complete: nowSec >= releaseSec && first <= from + DAY_RULES.candleSec };
}

export type CandleState = "inside" | "above" | "below";

export interface WindowCandle {
  time: number;
  close: number;
  /** the candle has closed (its end is not after now); an open one is shown but never signals */
  complete: boolean;
  state: CandleState;
  /** it closed beyond the range on the side the surprise does NOT allow: skipped, not an entry */
  against: boolean;
}

export type DaySide = "long" | "short";

export interface DaySignal {
  side: DaySide;
  /** the candle that closed beyond the range, and when it closed */
  candleTime: number;
  closedAt: number;
  /** the future's next open after it: the entry reference; undefined until that candle exists */
  entry?: number;
  /** 1.5 x ATR(14) of the 5-minute future at the signal candle, in the future's points */
  atr?: number;
  rPoints?: number;
  stop?: number;
  tp1?: number;
  tp2?: number;
}

export interface WindowWatch {
  candles: WindowCandle[];
  signal?: DaySignal;
  /** how many closes were beyond the range on the wrong side of the surprise */
  skippedAgainst: number;
  /** the entry cut-off has passed */
  cutoffReached: boolean;
}

/** ATR over the last `period` true ranges ending at index `i` (a plain mean; at least a few candles are needed). */
function atrAt(bars: readonly DayBar[], i: number, period: number): number | undefined {
  const start = Math.max(1, i - period + 1);
  const tr: number[] = [];
  for (let k = start; k <= i; k++) tr.push(Math.max(bars[k].high - bars[k].low, Math.abs(bars[k].high - bars[k - 1].close), Math.abs(bars[k].low - bars[k - 1].close)));
  return tr.length >= 3 ? tr.reduce((a, b) => a + b, 0) / tr.length : undefined;
}

/**
 * Watch the window after the print. A 5-minute candle that closes above the range or below it is a break. With a surprise side only a break on that side
 * is an entry (a break the other way is marked and skipped: price disagrees with the number); with no side (the surprise is under the threshold, or not
 * known yet) a break either way is. A new entry needs the candle to have closed within `cutoffMin` of the print. The entry reference is the next open,
 * the risk R is 1.5 x ATR(14), and the stop sits 1R away with targets at +1R and +2R. Closed candles only.
 */
export function watchWindow(bars: readonly DayBar[], releaseSec: number, range: DayRange, surpriseSide: DaySide | undefined, nowSec: number, cutoffMin: number = DAY_RULES.cutoffMin): WindowWatch {
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  const cutoffAt = releaseSec + cutoffMin * 60;
  const candles: WindowCandle[] = [];
  let signal: DaySignal | undefined;
  let skippedAgainst = 0;
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    if (b.time < releaseSec || b.time >= cutoffAt) continue;
    const closedAt = b.time + DAY_RULES.candleSec;
    const complete = closedAt <= nowSec;
    const state: CandleState = b.close > range.high ? "above" : b.close < range.low ? "below" : "inside";
    const side: DaySide | undefined = state === "above" ? "long" : state === "below" ? "short" : undefined;
    const against = complete && side !== undefined && surpriseSide !== undefined && side !== surpriseSide;
    if (against) skippedAgainst++;
    candles.push({ time: b.time, close: b.close, complete, state, against });
    if (!signal && complete && side && !against && closedAt <= cutoffAt) {
      const atr = atrAt(sorted, i, DAY_RULES.atrPeriod);
      const next = sorted.find((x) => x.time === b.time + DAY_RULES.candleSec);
      const entry = next?.open;
      const rPoints = atr === undefined ? undefined : atr * DAY_RULES.atrMult;
      const dir = side === "long" ? 1 : -1;
      signal = { side, candleTime: b.time, closedAt, entry, atr, rPoints, ...(entry !== undefined && rPoints !== undefined ? { stop: entry - dir * rPoints, tp1: entry + dir * rPoints, tp2: entry + dir * 2 * rPoints } : {}) };
    }
  }
  return { candles, signal, skippedAgainst, cutoffReached: nowSec >= cutoffAt };
}

export interface StrikePick {
  strike: number;
  /** the Upstox instrument key of the option, to follow its live quote */
  key?: string;
  side: DaySide;
  /** what buying it costs per unit (the ask, else the last price) and for one lot */
  premium: number;
  cost: number;
  delta: number;
  theta?: number;
  iv?: number;
  oi?: number;
  volume?: number;
  /** the loss at 1R in rupees: the future's R translated through the delta, times the lot; undefined before R is known */
  rupeeR?: number;
}

export interface StrikeSuggestion {
  pick?: StrikePick;
  /** the strikes around the money for display (two below, the money, two above) */
  rows: { strike: number; leg?: OptionLeg; atm: boolean }[];
  note: string;
}

const price = (l?: OptionLeg) => (l?.ask && l.ask > 0 ? l.ask : l?.ltp && l.ltp > 0 ? l.ltp : undefined);

/**
 * The option to buy for a side: a call for a long, a put for a short. At the money if |delta| is at least 0.5, else the strike nearest 0.6 delta, but only
 * one that fits the capital; when R is known and 1R on the option would exceed the loss cap, a lower-delta strike, or no trade. Nearest expiry is the
 * chain's own choice. The pick is a suggestion: the order is placed by hand.
 */
export function suggestStrike(chain: Chain | null | undefined, side: DaySide | undefined, rPoints?: number, capital: number = DAY_RULES.capital, lossCap: number = DAY_RULES.lossCap): StrikeSuggestion {
  if (!chain || !chain.rows.length) return { rows: [], note: "No option chain yet." };
  const lot = chain.lot ?? 1;
  const legOf = (r: ChainRow) => (side === "short" ? r.pe : r.ce);
  const sorted = [...chain.rows].sort((a, b) => a.strike - b.strike);
  const atmIdx = chain.atm === undefined ? Math.floor(sorted.length / 2) : Math.max(0, sorted.findIndex((r) => r.strike === chain.atm));
  const around = sorted.slice(Math.max(0, atmIdx - 2), atmIdx + 3);
  const rows = around.map((r) => ({ strike: r.strike, leg: legOf(r) ?? r.ce ?? r.pe, atm: r.strike === chain.atm }));
  if (!side) return { rows, note: "No side yet: the strike is chosen once the entry side is known." };

  const cands = sorted
    .map((r) => {
      const leg = legOf(r);
      const premium = price(leg);
      const delta = leg?.delta === undefined ? undefined : Math.abs(leg.delta);
      return leg && premium !== undefined && delta !== undefined && delta > 0 ? { r, leg, premium, delta, cost: premium * lot } : undefined;
    })
    .filter((c): c is NonNullable<typeof c> => c !== undefined && c.cost <= capital);
  if (!cands.length) return { rows, note: `No strike with a price and a delta fits ₹${capital.toLocaleString("en-IN")}.` };

  // preferred: the at-the-money strike when |delta| >= 0.5, else the strike nearest 0.6 delta among those at or above 0.5
  const atmCand = cands.find((c) => c.r.strike === chain.atm);
  const firm = cands.filter((c) => c.delta >= 0.5);
  const preferred = atmCand && atmCand.delta >= 0.5 ? atmCand : firm.length ? [...firm].sort((a, b) => Math.abs(a.delta - 0.6) - Math.abs(b.delta - 0.6))[0] : [...cands].sort((a, b) => b.delta - a.delta)[0];

  const toPick = (c: (typeof cands)[number]): StrikePick => ({ strike: c.r.strike, key: c.leg.ukey, side, premium: c.premium, cost: c.cost, delta: c.delta, theta: c.leg.theta, iv: c.leg.iv, oi: c.leg.oi, volume: c.leg.volume, rupeeR: rPoints === undefined ? undefined : rPoints * c.delta * lot });
  const first = toPick(preferred);
  if (first.rupeeR === undefined || first.rupeeR <= lossCap) return { pick: first, rows, note: first.rupeeR === undefined ? "R is not known yet: the loss cap is checked once the entry candle closes." : "Fits the capital and the loss cap." };

  // 1R is over the cap: step down to a lower-delta strike until it fits
  for (const c of cands.filter((x) => x.delta < preferred.delta).sort((a, b) => b.delta - a.delta)) {
    const p = toPick(c);
    if (p.rupeeR! <= lossCap) return { pick: p, rows, note: `1R on the nearer strike would be ₹${Math.round(first.rupeeR).toLocaleString("en-IN")}, over the ₹${lossCap.toLocaleString("en-IN")} cap: a lower-delta strike.` };
  }
  return { pick: undefined, rows, note: `No trade: 1R is over the ₹${lossCap.toLocaleString("en-IN")} cap even on the lowest-delta strike that fits.` };
}

export interface ReadinessItem {
  id: "release" | "forecast" | "candles" | "chain" | "number";
  label: string;
  ok: boolean;
  detail: string;
}

export interface ReadinessInput {
  now: number;
  /** the scheduled release is known (epoch ms) */
  releaseAt?: number;
  /** a forecast is available (typed in, recorded or consensus) and where it came from */
  forecast?: { source: string };
  /** the open time of the newest 5-minute candle of the future (epoch seconds) */
  lastCandle?: number;
  /** the chain was read this long ago (ms), and how many strikes have a price and a delta */
  chainAgeMs?: number;
  chainPriced?: number;
  /** the API could be asked for the report at all */
  reportReachable?: boolean;
}

/**
 * The things that must be true before the print, each with a plain answer: the release time, a forecast, fresh candles, a live chain with greeks, and
 * the report source answering. Shown in the prep and range stages so a dead feed is seen an hour early, not at 20:00.
 */
export function readiness(i: ReadinessInput): ReadinessItem[] {
  const candleAge = i.lastCandle === undefined ? undefined : i.now - i.lastCandle * 1000;
  return [
    { id: "release", label: "Release time", ok: i.releaseAt !== undefined && i.releaseAt > i.now - 3 * 3600_000, detail: i.releaseAt === undefined ? "no release is stored" : "stored" },
    { id: "forecast", label: "Forecast", ok: i.forecast !== undefined, detail: i.forecast ? i.forecast.source : "none yet: type the number you read on Trading Economics or Investing.com" },
    { id: "candles", label: "5-minute candles", ok: candleAge !== undefined && candleAge < 12 * 60_000, detail: candleAge === undefined ? "none loaded" : candleAge < 12 * 60_000 ? "current" : `the newest opened ${Math.round(candleAge / 60_000)} minutes ago (is MCX open?)` },
    { id: "chain", label: "Option chain", ok: i.chainAgeMs !== undefined && i.chainAgeMs < 20_000 && (i.chainPriced ?? 0) >= 3, detail: i.chainAgeMs === undefined ? "not loaded" : (i.chainPriced ?? 0) < 3 ? "too few strikes with a price and a delta" : i.chainAgeMs < 20_000 ? `${i.chainPriced} strikes with prices and greeks` : `last read ${Math.round(i.chainAgeMs / 1000)} s ago` },
    { id: "number", label: "Report source", ok: i.reportReachable === true, detail: i.reportReachable === undefined ? "checking" : i.reportReachable ? "answering" : "not answering: the number will not appear by itself" },
  ];
}
