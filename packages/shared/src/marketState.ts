// The state of the market right now, read from the live data we hold: where price sits against the levels the market watches, what the book and the
// recent bars lean toward, what the options say, the premium over NYMEX x USD/INR, and what is coming. Pure and tested; the panel is web MarketStatePanel.tsx.
//
// This is a READ, not a forecast. Every reading states one rule and one threshold (STATE_RULES), says which way it leans (up, down, or neutral: context only) and why,
// and the panel shows disagreement instead of averaging it into a score. Whether a lean has ever paid is measured separately on recorded data
// (`scripts/state-forward.ts`, pre-registered, with days held out) and until it is measured, nothing here is a signal.
import type { Bar, Quote } from "./index";
import { dayLevels } from "./dayLevels";
import { sessionPivots } from "./pivots";
import { atr, hurst, regimeOf, volPercentile, type Regime } from "./stats";
import type { Chain } from "./options";

export type Lean = "up" | "down" | "neutral";
export type Group = "Location" | "Pressure" | "Options" | "Cross-market" | "Calendar" | "Regime";

export interface Reading {
  id: string;
  group: Group;
  label: string;
  /** the figure as it should be printed ("+0.4 ATR", "62%"); empty when `lean` is "na" */
  value: string;
  /** "na" = the data to read this is missing; "neutral" = context only, no lean */
  lean: Lean | "na";
  /** one sentence: the rule and why it leans that way (or why it cannot be read) */
  note: string;
  /** a reading that asks for caution rather than a direction (an imminent release) */
  warn?: boolean;
}

/** Every threshold in one place; each reading uses one. Changing one is a decision to record, not a tweak. */
export const STATE_RULES = {
  /** price beyond VWAP by this many ATR leans that way */
  vwapAtr: 0.1,
  /** day-range position at or above / at or below these leans up / down (continuation) */
  rangeHigh: 0.8,
  rangeLow: 0.2,
  /** change over the last `momentumBars` 5-minute bars, in ATR */
  momentumBars: 6,
  momentumAtr: 1,
  /** (bid - ask) / (bid + ask) of resting size */
  bookImbalance: 0.25,
  totalBookImbalance: 0.15,
  /** a level this close (in ATR) is "at" the level */
  atLevelAtr: 0.5,
  /** premium rank (0 to 100) at or above / at or below these leans down / up (pull back toward fair value) */
  premiumHigh: 90,
  premiumLow: 10,
  /** minutes before a release in which the read says to stand aside, and minutes after in which the first move is still forming */
  eventBefore: 30,
  eventAfter: 5,
  /** a quote older than this (seconds) makes the whole read stale */
  staleSec: 120,
  /** bars needed before the 5-minute readings are trusted */
  minBars: 30,
  atrPeriod: 14,
} as const;

export interface PremiumInfo {
  pct: number;
  /** where it sits among the recent history, 0 to 100 */
  rank?: number;
  median?: number;
}

export interface UpcomingEvent {
  title: string;
  /** epoch ms */
  at: number;
}

export interface StateInput {
  quote?: Quote;
  /** COMPLETED 5-minute bars, oldest first (never the forming one) */
  bars: Bar[];
  chain?: Chain | null;
  premium?: PremiumInfo;
  event?: UpcomingEvent;
  now: number;
  /** price decimals, for printing levels */
  decimals?: number;
}

export interface MarketState {
  readings: Reading[];
  /** how many readings lean each way, and the plain summary of whether they agree */
  tally: { up: number; down: number; neutral: number; na: number };
  agreement: "aligned-up" | "aligned-down" | "mixed" | "no-lean";
  summary: string;
  stale: boolean;
  ageSec?: number;
  caveats: string[];
}

const fmt = (n: number, dp: number) => n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const sgn = (n: number, dp: number) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${fmt(Math.abs(n), dp)}`;
const na = (id: string, group: Group, label: string, note: string): Reading => ({ id, group, label, value: "", lean: "na", note });

/** (bid - ask) / (bid + ask) over the book's resting size; positive = more resting size on the bid. Undefined without a book. */
export function bookImbalance(q: Pick<Quote, "bidQty" | "askQty" | "depth">): number | undefined {
  let b = 0;
  let a = 0;
  if (q.depth?.length) {
    for (const l of q.depth) {
      b += l.bidQ ?? 0;
      a += l.askQ ?? 0;
    }
  } else {
    b = q.bidQty ?? 0;
    a = q.askQty ?? 0;
  }
  return b + a > 0 ? (b - a) / (b + a) : undefined;
}

/** The readings that need only the 5-minute bars and the live price, so the same rules can be run over history (`scripts/state-forward.ts`). */
export function barReadings(bars: Bar[], price: number, opts: { atp?: number; dayHigh?: number; dayLow?: number; decimals?: number } = {}): Reading[] {
  const dp = opts.decimals ?? 2;
  const out: Reading[] = [];
  const a = bars.length > STATE_RULES.atrPeriod + 1 ? atr(bars, STATE_RULES.atrPeriod) : undefined;
  if (bars.length < STATE_RULES.minBars || !a) {
    const why = `needs ${STATE_RULES.minBars} completed 5-minute bars (have ${bars.length})`;
    return [na("vwap", "Location", "Against VWAP", why), na("range", "Location", "Day range", why), na("momentum", "Pressure", "Momentum", why), na("levels", "Location", "Levels", why), na("regime", "Regime", "Regime", why)];
  }

  // against the session VWAP
  if (opts.atp && opts.atp > 0) {
    const d = (price - opts.atp) / a;
    out.push({ id: "vwap", group: "Location", label: "Against VWAP", value: `${sgn(d, 2)} ATR`, lean: d >= STATE_RULES.vwapAtr ? "up" : d <= -STATE_RULES.vwapAtr ? "down" : "neutral", note: `Price ${fmt(price, dp)} against the exchange's average traded price ${fmt(opts.atp, dp)}. Leans with the side of VWAP it holds beyond ${STATE_RULES.vwapAtr} ATR (continuation); not yet shown to pay.` });
  } else out.push(na("vwap", "Location", "Against VWAP", "the feed gives no average traded price"));

  // position in the day's range
  const hi = opts.dayHigh;
  const lo = opts.dayLow;
  if (hi !== undefined && lo !== undefined && hi > lo) {
    const pos = (price - lo) / (hi - lo);
    out.push({ id: "range", group: "Location", label: "Day range", value: `${Math.round(pos * 100)}%`, lean: pos >= STATE_RULES.rangeHigh ? "up" : pos <= STATE_RULES.rangeLow ? "down" : "neutral", note: `Day low ${fmt(lo, dp)}, high ${fmt(hi, dp)}. At or above ${STATE_RULES.rangeHigh * 100}% leans up and at or below ${STATE_RULES.rangeLow * 100}% leans down (continuation); a reversal is as plausible, which is why it is a lean and not a call.` });
  } else out.push(na("range", "Location", "Day range", "no day high and low yet"));

  // momentum over the last 30 minutes
  const m = STATE_RULES.momentumBars;
  const ref = bars[bars.length - 1 - m];
  if (ref) {
    const d = (price - ref.close) / a;
    out.push({ id: "momentum", group: "Pressure", label: `Last ${m * 5} min`, value: `${sgn(d, 2)} ATR`, lean: d >= STATE_RULES.momentumAtr ? "up" : d <= -STATE_RULES.momentumAtr ? "down" : "neutral", note: `Move since the close ${m * 5} minutes ago, in 5-minute ATR (${fmt(a, dp)}). A move of ${STATE_RULES.momentumAtr} ATR or more leans the same way (continuation).` });
  }

  // the nearest levels above and below
  const cands: { name: string; price: number }[] = [];
  const dl = dayLevels(bars);
  if (dl) {
    cands.push({ name: "prev day high", price: dl.previous.high }, { name: "prev day low", price: dl.previous.low });
    cands.push({ name: "day high", price: dl.today.high }, { name: "day low", price: dl.today.low });
  }
  const sp = sessionPivots(bars).at(-1);
  if (sp) cands.push({ name: "pivot", price: sp.levels.P }, { name: "R1", price: sp.levels.R1 }, { name: "S1", price: sp.levels.S1 });
  const above = cands.filter((c) => c.price > price).sort((x, y) => x.price - y.price)[0];
  const below = cands.filter((c) => c.price < price).sort((x, y) => y.price - x.price)[0];
  if (above || below) {
    const part = (c: typeof above, dir: string) => (c ? `${c.name} ${fmt(c.price, dp)} is ${fmt(Math.abs(c.price - price) / a, 1)} ATR ${dir}` : `nothing ${dir}`);
    const near = [above, below].filter((c) => c && Math.abs(c.price - price) / a <= STATE_RULES.atLevelAtr);
    out.push({ id: "levels", group: "Location", label: "Nearest levels", value: near.length ? `at ${near[0]!.name}` : `${above ? fmt(above.price, dp) : "—"} / ${below ? fmt(below.price, dp) : "—"}`, lean: "neutral", note: `${part(above, "above")}; ${part(below, "below")}. Context only: levels are where reactions are watched for, not a direction.` });
  } else out.push(na("levels", "Location", "Nearest levels", "needs a few sessions of bars to know yesterday's range"));

  // regime
  const h = hurst(bars);
  const vp = volPercentile(bars, 20);
  const regime: Regime | undefined = regimeOf(h);
  out.push(
    regime
      ? { id: "regime", group: "Regime", label: "Regime", value: `${regime}${vp !== undefined ? `, vol ${Math.round(vp)}th pct` : ""}`, lean: "neutral", note: `Hurst ${h!.toFixed(2)} (above 0.58 trending, below 0.42 mean-reverting). It says whether breakouts or fades have suited this stretch, not which way price goes.` }
      : na("regime", "Regime", "Regime", "needs 64 returns for the Hurst estimate"),
  );
  return out;
}

/** What the options chain says about where price sits among the strikes. All context: open interest walls and IV describe positioning, they do not give a side. */
export function optionReadings(chain: Chain | null | undefined, spot: number, atrPoints: number | undefined, dp: number): Reading[] {
  if (!chain || !chain.rows.length) return [na("options", "Options", "Option chain", "no chain loaded for this underlying")];
  const out: Reading[] = [];
  if (chain.pcr !== undefined) out.push({ id: "pcr", group: "Options", label: "Put/call OI", value: chain.pcr.toFixed(2), lean: "neutral", note: "Put open interest over call open interest across the strikes shown. Read together with the walls: a high figure can be hedging as easily as bearishness." });
  if (chain.maxPain !== undefined && atrPoints) out.push({ id: "maxpain", group: "Options", label: "Max pain", value: `${fmt(chain.maxPain, 0)} (${sgn((chain.maxPain - spot) / atrPoints, 1)} ATR)`, lean: "neutral", note: "The strike where option buyers lose the most at expiry, over the strikes shown. A weak magnet at best; it matters near expiry." });
  const calls = chain.rows.filter((r) => r.strike > spot && (r.ce?.oi ?? 0) > 0).sort((a, b) => (b.ce!.oi ?? 0) - (a.ce!.oi ?? 0))[0];
  const puts = chain.rows.filter((r) => r.strike < spot && (r.pe?.oi ?? 0) > 0).sort((a, b) => (b.pe!.oi ?? 0) - (a.pe!.oi ?? 0))[0];
  if (calls || puts)
    out.push({ id: "walls", group: "Options", label: "OI walls", value: `${puts ? fmt(puts.strike, 0) : "—"} / ${calls ? fmt(calls.strike, 0) : "—"}`, lean: "neutral", note: `Biggest put open interest below spot (${puts ? fmt(puts.pe!.oi!, 0) : "none"}) and biggest call open interest above (${calls ? fmt(calls.ce!.oi!, 0) : "none"}): where sellers have most at stake. Walls can hold or give way.` });
  const atm = chain.rows.find((r) => r.strike === chain.atm);
  const ivs = [atm?.ce?.iv, atm?.pe?.iv].filter((v): v is number => typeof v === "number" && v > 0);
  if (ivs.length) out.push({ id: "iv", group: "Options", label: "ATM IV", value: `${(ivs.reduce((s, v) => s + v, 0) / ivs.length).toFixed(1)}%`, lean: "neutral", note: "Average implied volatility of the at-the-money call and put. Compare it with its own recent level: rising IV with flat price means a move is being paid for." });
  if (!out.length) out.push(na("options", "Options", "Option chain", "the chain has no open interest or implied volatility yet"));
  void dp;
  return out;
}

/** The whole read. `bars` must be completed bars only. */
export function marketState(input: StateInput): MarketState {
  const { quote, bars, now } = input;
  const dp = input.decimals ?? 2;
  const caveats: string[] = [];
  const readings: Reading[] = [];
  const ageSec = quote ? Math.max(0, Math.round((now - quote.time) / 1000)) : undefined;
  const stale = !quote || (ageSec ?? 0) > STATE_RULES.staleSec;
  if (!quote) {
    return { readings: [na("quote", "Location", "Price", "no quote for this instrument yet")], tally: { up: 0, down: 0, neutral: 0, na: 1 }, agreement: "no-lean", summary: "No live price, so nothing can be read.", stale: true, caveats };
  }
  if (stale) caveats.push(`The last quote is ${ageSec}s old: the exchange may be closed or the feed silent, so these readings describe the last price, not now.`);
  if (quote.delayedBy > 0) caveats.push(`This feed runs ${Math.round(quote.delayedBy / 60)} minutes behind.`);

  const base = barReadings(bars, quote.price, { atp: quote.atp, dayHigh: quote.high, dayLow: quote.low, decimals: dp });
  readings.push(...base);

  // the book: the best five levels, and the whole book's pending quantity
  const imb = bookImbalance(quote);
  if (imb !== undefined) {
    readings.push({ id: "book", group: "Pressure", label: "Book (top levels)", value: `${sgn(imb * 100, 0)}%`, lean: imb >= STATE_RULES.bookImbalance ? "up" : imb <= -STATE_RULES.bookImbalance ? "down" : "neutral", note: `Resting size on the bid against the ask over ${quote.depth?.length ?? 1} level(s). Beyond ±${STATE_RULES.bookImbalance * 100}% it leans toward the heavier side, but resting orders can be pulled; it is a lean, not flow.` });
  } else readings.push(na("book", "Pressure", "Book (top levels)", "the feed gives no depth for this instrument"));
  if (quote.totalBuyQty && quote.totalSellQty) {
    const t = (quote.totalBuyQty - quote.totalSellQty) / (quote.totalBuyQty + quote.totalSellQty);
    readings.push({ id: "totalbook", group: "Pressure", label: "Book (all pending)", value: `${sgn(t * 100, 0)}%`, lean: t >= STATE_RULES.totalBookImbalance ? "up" : t <= -STATE_RULES.totalBookImbalance ? "down" : "neutral", note: `Total pending buy against sell quantity in the whole book, beyond ±${STATE_RULES.totalBookImbalance * 100}%. Far-away orders count too, so it is the weaker of the two book readings.` });
  }

  const a = bars.length > STATE_RULES.atrPeriod + 1 ? atr(bars, STATE_RULES.atrPeriod) : undefined;
  if (input.chain !== undefined) readings.push(...optionReadings(input.chain, quote.price, a, dp));

  if (input.premium) {
    const p = input.premium;
    const rank = p.rank;
    readings.push(
      rank === undefined
        ? { id: "premium", group: "Cross-market", label: "MCX premium", value: `${sgn(p.pct, 2)}%`, lean: "neutral", note: "MCX against NYMEX x USD/INR. Too little history to say where this sits in its usual range." }
        : { id: "premium", group: "Cross-market", label: "MCX premium", value: `${sgn(p.pct, 2)}% (${rank}th pct)`, lean: rank >= STATE_RULES.premiumHigh ? "down" : rank <= STATE_RULES.premiumLow ? "up" : "neutral", note: `MCX against NYMEX x USD/INR, higher than ${rank}% of recent bars. At the extremes (${STATE_RULES.premiumLow}th / ${STATE_RULES.premiumHigh}th) it leans toward fair value; NYMEX data here is 10 minutes late, so it explains MCX and does not lead it. Not yet shown to pay.` },
    );
  }

  if (input.event) {
    const min = (input.event.at - now) / 60_000;
    if (min <= STATE_RULES.eventBefore && min >= -STATE_RULES.eventAfter)
      readings.push({ id: "event", group: "Calendar", label: input.event.title, value: min >= 0 ? `in ${Math.ceil(min)} min` : `${Math.floor(-min)} min ago`, lean: "neutral", warn: true, note: `A release inside ${STATE_RULES.eventBefore} minutes (or ${STATE_RULES.eventAfter} after): spreads widen and the first move is often reversed. The read has no edge here; stand aside or size down.` });
    else readings.push({ id: "event", group: "Calendar", label: input.event.title, value: min < 0 ? "out" : `in ${min >= 120 ? `${(min / 60).toFixed(1)} h` : `${Math.round(min)} min`}`, lean: "neutral", note: "The next scheduled release that moves this market." });
  }

  const tally = { up: 0, down: 0, neutral: 0, na: 0 };
  for (const r of readings) tally[r.lean]++;
  const leaning = tally.up + tally.down;
  const agreement: MarketState["agreement"] = leaning === 0 ? "no-lean" : tally.down === 0 && tally.up >= 2 ? "aligned-up" : tally.up === 0 && tally.down >= 2 ? "aligned-down" : "mixed";
  const names = (l: Lean) => readings.filter((r) => r.lean === l).map((r) => r.label).join(", ");
  const warn = readings.some((r) => r.warn);
  const summary =
    (warn ? "A release is close: stand aside or size down. " : "") +
    (agreement === "no-lean"
      ? "Nothing leans either way."
      : agreement === "mixed"
        ? `Mixed: ${tally.up} lean up (${names("up") || "none"}), ${tally.down} lean down (${names("down") || "none"}). The readings disagree, which is the information.`
        : agreement === "aligned-up"
          ? `${tally.up} readings lean up (${names("up")}), none down.`
          : `${tally.down} readings lean down (${names("down")}), none up.`) +
    " A lean is a stated rule, not a forecast.";
  return { readings, tally, agreement, summary, stale, ageSec, caveats };
}
