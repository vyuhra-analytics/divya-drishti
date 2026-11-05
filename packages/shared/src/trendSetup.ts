// The trend setup: a repeatable checklist for buying an MCX option in the direction of the trend. MCX futures technicals give the bias (daily) and the
// timing (60-minute levels, 15-minute trigger), NYMEX and USD/INR must not contradict the move, an event filter keeps the trade away from releases, and
// the strike is chosen by delta, liquidity and the loss cap. Every threshold is in SETUP_RULES; a `?` in a comment marks a default the owner has not
// confirmed. Pure and tested; the screen is web TrendSetupPanel.tsx. A checklist, not a forecast: nothing here has been tested on history yet.
import type { Bar } from "./index";
import type { Chain, ChainRow, OptionLeg } from "./options";
import { ema } from "./indicators";
import { atr } from "./stats";
import { DAY_RULES, type DaySide } from "./reportDay";

export const SETUP_RULES = {
  /** the bias rule's averages; the long one is context only (MCX daily history from Upstox is too short for it) */
  emaFast: 20,
  emaSlow: 50,
  emaLong: 200,
  /** an average is rising when it is above its value this many bars ago */
  slopeBars: 5,
  /** a swing high is higher than this many bars on each side (and a swing low lower): known only once those later bars have closed */
  swingSide: 2,
  /** a combined NYMEX + rupee day move smaller than this (percent) is flat */
  flatPct: 0.1,
  /** MCX premium over NYMEX x USD/INR at or beyond this rank (0 to 100, or 100 minus it) is a divergence: stand aside */
  basisExtreme: 95,
  /** no new entry this long before a high-impact release for the market, or this long after it */
  eventBeforeMin: 120,
  eventAfterMin: 30,
  /** an open trade is closed this long before a release, and this long before the MCX close (no overnight hold) ? */
  exitBeforeEventMin: 15,
  exitBeforeCloseMin: 30,
  /** 15-minute trigger: a pullback to the 15-minute EMA within this many bars, then a close back beyond it and beyond the previous bar */
  pullbackBars: 6,
  triggerEma: 20,
  atrPeriod: 14,
  /** the stop (the pullback's extreme) must sit between these multiples of the 15-minute ATR from the entry */
  minRAtr: 0.5,
  maxRAtr: 2.5,
  /** room: the 60-minute level in the trade's direction must be at least this many R away */
  minRoomR: 1,
  tp1R: 1,
  tp2R: 2,
  /** the strike: |delta| inside this band, the one nearest `deltaTarget` (at the money or slightly in it) */
  deltaMin: 0.4,
  deltaMax: 0.6,
  deltaTarget: 0.55,
  /** bid-ask spread at most this share of the premium (percent) */
  maxSpreadPct: 5,
  capital: DAY_RULES.capital,
  lossCap: DAY_RULES.lossCap,
} as const;

export type SetupBias = "bullish" | "bearish" | "none";
export type StepStatus = "pass" | "fail" | "wait" | "na";

export interface Swing {
  index: number;
  time: number;
  price: number;
  kind: "high" | "low";
}

/** Swing highs and lows (fractals): a bar whose high is above the `side` bars before and not below the `side` after; only bars with `side` later bars count. */
export function swings(bars: readonly Bar[], side: number = SETUP_RULES.swingSide): Swing[] {
  const out: Swing[] = [];
  for (let i = side; i < bars.length - side; i++) {
    const b = bars[i];
    let hi = true;
    let lo = true;
    for (let k = 1; k <= side; k++) {
      if (!(b.high > bars[i - k].high) || b.high < bars[i + k].high) hi = false;
      if (!(b.low < bars[i - k].low) || b.low > bars[i + k].low) lo = false;
    }
    if (hi) out.push({ index: i, time: b.time, price: b.high, kind: "high" });
    if (lo) out.push({ index: i, time: b.time, price: b.low, kind: "low" });
  }
  return out;
}

export type Structure = "up" | "down" | "mixed" | "unknown";

/** Higher highs and higher lows = up; lower highs and lower lows = down; anything else mixed. Needs two swing highs and two swing lows. */
export function structureOf(sw: readonly Swing[]): Structure {
  const h = sw.filter((s) => s.kind === "high").slice(-2);
  const l = sw.filter((s) => s.kind === "low").slice(-2);
  if (h.length < 2 || l.length < 2) return "unknown";
  if (h[1].price > h[0].price && l[1].price > l[0].price) return "up";
  if (h[1].price < h[0].price && l[1].price < l[0].price) return "down";
  return "mixed";
}

export interface Trend {
  bias: SetupBias;
  close: number;
  emaFast?: number;
  emaSlow?: number;
  emaLong?: number;
  fastRising?: boolean;
  slowRising?: boolean;
  structure: Structure;
  /** one sentence on why */
  reason: string;
}

const lastAndBefore = (pts: { value: number }[], back: number) => (pts.length > back ? { now: pts[pts.length - 1].value, then: pts[pts.length - 1 - back].value } : undefined);

/**
 * The bias rule on one timeframe's COMPLETED bars: price above a rising 20 and 50 EMA with higher highs and higher lows = bullish; below a falling 20 and 50
 * with lower highs and lower lows = bearish; anything else = none (chop: no trade).
 */
export function trendOf(bars: readonly Bar[], r = SETUP_RULES): Trend {
  const list = bars as Bar[];
  const close = list.at(-1)?.close ?? NaN;
  const f = lastAndBefore(ema(list, r.emaFast), r.slopeBars);
  const s = lastAndBefore(ema(list, r.emaSlow), r.slopeBars);
  const long = ema(list, r.emaLong).at(-1)?.value;
  const structure = structureOf(swings(list, r.swingSide));
  if (!f || !s) return { bias: "none", close, structure, reason: `needs ${r.emaSlow + r.slopeBars} completed bars for the ${r.emaSlow} EMA and its slope (have ${list.length})` };
  const fastRising = f.now > f.then;
  const slowRising = s.now > s.then;
  const base = { close, emaFast: f.now, emaSlow: s.now, emaLong: long, fastRising, slowRising, structure };
  if (close > f.now && close > s.now && fastRising && slowRising && structure === "up") return { ...base, bias: "bullish", reason: `above a rising ${r.emaFast} and ${r.emaSlow} EMA with higher highs and higher lows` };
  if (close < f.now && close < s.now && !fastRising && !slowRising && structure === "down") return { ...base, bias: "bearish", reason: `below a falling ${r.emaFast} and ${r.emaSlow} EMA with lower highs and lower lows` };
  const why = [
    close > f.now && close > s.now ? "above both EMAs" : close < f.now && close < s.now ? "below both EMAs" : "between the EMAs",
    fastRising === slowRising ? `EMAs ${fastRising ? "rising" : "falling"}` : "EMAs pointing different ways",
    `structure ${structure}`,
  ];
  return { ...base, bias: "none", reason: `no clean trend: ${why.join(", ")}` };
}

export interface Levels {
  support?: number;
  resistance?: number;
}

/** The nearest swing low below and swing high above `price` on the 60-minute bars: the levels the trade must have room to. */
export function levelsAround(bars: readonly Bar[], price: number, r = SETUP_RULES): Levels {
  const sw = swings(bars, r.swingSide);
  const support = sw.filter((s) => s.kind === "low" && s.price < price).sort((a, b) => b.price - a.price)[0]?.price;
  const resistance = sw.filter((s) => s.kind === "high" && s.price > price).sort((a, b) => a.price - b.price)[0]?.price;
  return { support, resistance };
}

export interface ConfirmInput {
  /** NYMEX's day move and the rupee's (USD/INR), in percent; their sum is the move MCX's fair value made */
  nymexPct?: number;
  fxPct?: number;
  /** where MCX's premium over NYMEX x USD/INR sits in its recent range, 0 to 100 */
  premiumRank?: number;
}

export interface Confirmation {
  status: StepStatus;
  detail: string;
}

/** Does NYMEX with the rupee support the MCX bias? A move explained by the rupee alone is accepted; a conflict with no rupee move to explain it is not. */
export function confirmWithGlobal(bias: SetupBias, c: ConfirmInput, r = SETUP_RULES): Confirmation {
  if (bias === "none") return { status: "na", detail: "no bias to confirm" };
  if (c.nymexPct === undefined || c.fxPct === undefined) return { status: "fail", detail: "NYMEX or USD/INR day move not known: the trade cannot be confirmed" };
  const dir = bias === "bullish" ? 1 : -1;
  const fair = c.nymexPct + c.fxPct;
  const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
  const parts = `NYMEX ${pct(c.nymexPct)}, rupee effect ${pct(c.fxPct)} (USD/INR), fair value ${pct(fair)}`;
  if (c.premiumRank !== undefined && (c.premiumRank >= r.basisExtreme || c.premiumRank <= 100 - r.basisExtreme))
    return { status: "fail", detail: `${parts}; MCX premium at the ${c.premiumRank}th percentile of its range: local positioning or a liquidity effect, stand aside` };
  if (Math.abs(fair) >= r.flatPct && Math.sign(fair) !== dir) return { status: "fail", detail: `${parts}: against the ${bias} bias` };
  const nymexAgainst = Math.abs(c.nymexPct) >= r.flatPct && Math.sign(c.nymexPct) !== dir;
  if (nymexAgainst && Math.abs(fair) < r.flatPct) return { status: "fail", detail: `${parts}: NYMEX goes the other way and the rupee does not explain it` };
  if (nymexAgainst) return { status: "pass", detail: `${parts}: NYMEX is against it but the rupee move explains the MCX move` };
  return { status: "pass", detail: Math.abs(fair) < r.flatPct ? `${parts}: flat, not against the bias` : `${parts}: supports the bias` };
}

export interface SetupEvent {
  title: string;
  /** epoch ms */
  at: number;
}

/** No new entry from `eventBeforeMin` before a high-impact release to `eventAfterMin` after it. `events` must already be filtered to the market and impact. */
export function eventFilter(events: readonly SetupEvent[], now: number, r = SETUP_RULES): Confirmation & { next?: SetupEvent } {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const blocking = sorted.find((e) => e.at - now <= r.eventBeforeMin * 60_000 && now - e.at <= r.eventAfterMin * 60_000);
  const next = sorted.find((e) => e.at > now);
  const mins = (ms: number) => (Math.abs(ms) >= 7_200_000 ? `${(Math.abs(ms) / 3_600_000).toFixed(1)} h` : `${Math.round(Math.abs(ms) / 60_000)} min`);
  if (blocking)
    return { status: "fail", next, detail: blocking.at > now ? `${blocking.title} in ${mins(blocking.at - now)}: implied volatility tends to rise before it and fall after, so no new premium is bought` : `${blocking.title} ${mins(now - blocking.at)} ago: the first move is still settling` };
  return { status: "pass", next, detail: next ? `next: ${next.title} in ${mins(next.at - now)}` : "no high-impact release ahead in the calendar" };
}

export interface Trigger {
  status: StepStatus;
  detail: string;
  /** the trigger bar (its open, epoch seconds) and the levels on the FUTURE */
  barTime?: number;
  entry?: number;
  stop?: number;
  rPoints?: number;
  tp1?: number;
  tp2?: number;
}

/**
 * The 15-minute timing for a known bias: within the last `pullbackBars` bars price came back to the 15-minute EMA (a low at or under it for a long, a high
 * at or over it for a short), and the newest completed bar closed back beyond the EMA and beyond the previous bar's high (low). Entry = `entry` (the live
 * price) or that bar's close; stop = the pullback's extreme; it must be between `minRAtr` and `maxRAtr` 15-minute ATRs away. Then TP1 at 1R, TP2 at 2R.
 */
export function trigger15(bars: readonly Bar[], bias: SetupBias, entry?: number, r = SETUP_RULES): Trigger {
  if (bias === "none") return { status: "na", detail: "waits for a bias" };
  const list = bars as Bar[];
  const e = ema(list, r.triggerEma);
  const a = atr(list, r.atrPeriod);
  if (list.length < r.triggerEma + r.pullbackBars || !a || e.length < r.pullbackBars + 1) return { status: "wait", detail: `needs ${r.triggerEma + r.pullbackBars} completed 15-minute bars` };
  const emaAt = new Map(e.map((p) => [p.time, p.value]));
  const k = list.length - 1;
  const last = list[k];
  const prev = list[k - 1];
  const window = list.slice(k - r.pullbackBars, k);
  const long = bias === "bullish";
  const touched = window.some((b) => {
    const v = emaAt.get(b.time);
    return v !== undefined && (long ? b.low <= v : b.high >= v);
  });
  const lastEma = emaAt.get(last.time)!;
  const resumed = long ? last.close > lastEma && last.close > prev.high : last.close < lastEma && last.close < prev.low;
  if (!touched) return { status: "wait", detail: `no pullback to the 15-minute ${r.triggerEma} EMA in the last ${r.pullbackBars} bars: do not chase` };
  if (!resumed) return { status: "wait", detail: `pullback seen; waiting for a 15-minute close back ${long ? "above" : "below"} the EMA and the previous bar's ${long ? "high" : "low"}` };
  const px = entry ?? last.close;
  const extreme = long ? Math.min(...window.map((b) => b.low), last.low) : Math.max(...window.map((b) => b.high), last.high);
  const rPoints = long ? px - extreme : extreme - px;
  if (!(rPoints > 0)) return { status: "fail", detail: "price is already through the pullback's extreme" };
  if (rPoints < r.minRAtr * a || rPoints > r.maxRAtr * a) return { status: "fail", detail: `stop ${rPoints.toFixed(1)} points away = ${(rPoints / a).toFixed(1)} ATR, outside ${r.minRAtr} to ${r.maxRAtr} ATR` };
  const d = long ? 1 : -1;
  return { status: "pass", detail: `pullback to the EMA, then a close back ${long ? "above" : "below"} it`, barTime: last.time, entry: px, stop: extreme, rPoints, tp1: px + d * r.tp1R * rPoints, tp2: px + d * r.tp2R * rPoints };
}

export interface SetupStrike {
  strike: number;
  type: "CE" | "PE";
  key?: string;
  premium: number;
  delta: number;
  spreadPct?: number;
  iv?: number;
  theta?: number;
  oi?: number;
  oiChange?: number;
  /** one lot's cost, and 1R in rupees = the future's R x |delta| x units */
  cost: number;
  rupeeR?: number;
  /** premium levels from the future's distances times the delta */
  stop?: number;
  tp1?: number;
  tp2?: number;
}

const ask = (l?: OptionLeg) => (l?.ask && l.ask > 0 ? l.ask : l?.ltp && l.ltp > 0 ? l.ltp : undefined);

/**
 * The option to buy: a call for a bullish trade, a put for a bearish one, |delta| inside the band (nearest the target: at the money or slightly in it),
 * a bid-ask spread within the limit, one lot within the capital, and 1R inside the loss cap (a lower delta inside the band if the first is over it).
 */
export function pickStrike(chain: Chain | null | undefined, bias: SetupBias, rPoints: number | undefined, r = SETUP_RULES): { pick?: SetupStrike; detail: string; status: StepStatus } {
  if (bias === "none") return { status: "na", detail: "waits for a bias" };
  if (!chain || !chain.rows.length) return { status: "fail", detail: "no option chain" };
  const type = bias === "bullish" ? "CE" : "PE";
  const units = chain.lot ?? 1;
  const legOf = (row: ChainRow) => (type === "CE" ? row.ce : row.pe);
  const all = chain.rows
    .map((row) => {
      const l = legOf(row);
      const premium = ask(l);
      const delta = l?.delta === undefined ? undefined : Math.abs(l.delta);
      if (!l || premium === undefined || delta === undefined) return undefined;
      const spreadPct = l.bid && l.ask && l.ask >= l.bid ? ((l.ask - l.bid) / l.ask) * 100 : undefined;
      return { row, l, premium, delta, spreadPct, cost: premium * units };
    })
    .filter((c): c is NonNullable<typeof c> => !!c);
  const band = all.filter((c) => c.delta >= r.deltaMin && c.delta <= r.deltaMax);
  if (!band.length) return { status: "fail", detail: `no ${type} with |delta| between ${r.deltaMin} and ${r.deltaMax} and a price` };
  const liquid = band.filter((c) => c.spreadPct !== undefined && c.spreadPct <= r.maxSpreadPct && c.cost <= r.capital);
  if (!liquid.length) return { status: "fail", detail: `the ${type}s in the delta band have a bid-ask spread over ${r.maxSpreadPct}% of the premium (or no two-sided quote), or one lot costs over ₹${r.capital.toLocaleString("en-IN")}` };
  const ranked = [...liquid].sort((a, b) => Math.abs(a.delta - r.deltaTarget) - Math.abs(b.delta - r.deltaTarget));
  const toPick = (c: (typeof ranked)[number]): SetupStrike => {
    const rp = rPoints === undefined ? undefined : rPoints * c.delta;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      strike: c.row.strike,
      type,
      key: c.l.ukey,
      premium: c.premium,
      delta: c.delta,
      spreadPct: c.spreadPct,
      iv: c.l.iv,
      theta: c.l.theta,
      oi: c.l.oi,
      oiChange: c.l.oiChange,
      cost: c.cost,
      rupeeR: rp === undefined ? undefined : rp * units,
      stop: rp === undefined ? undefined : r2(c.premium - rp),
      tp1: rp === undefined ? undefined : r2(c.premium + r.tp1R * rp),
      tp2: rp === undefined ? undefined : r2(c.premium + r.tp2R * rp),
    };
  };
  if (rPoints === undefined) return { status: "wait", pick: toPick(ranked[0]), detail: "best strike now; 1R is checked against the cap once the trigger fires" };
  for (const c of [ranked[0], ...ranked.slice(1).filter((x) => x.delta < ranked[0].delta).sort((a, b) => b.delta - a.delta)]) {
    const p = toPick(c);
    if (p.stop! <= 0) continue;
    if (p.rupeeR! <= r.lossCap) return { status: "pass", pick: p, detail: c === ranked[0] ? "inside the delta band, liquid, 1R within the cap" : `1R on the preferred strike was over ₹${r.lossCap.toLocaleString("en-IN")}: a lower delta inside the band` };
  }
  return { status: "fail", detail: `1R is over the ₹${r.lossCap.toLocaleString("en-IN")} cap on every strike in the delta band: the stop is too far for one lot` };
}

export interface SetupInput {
  /** COMPLETED bars of the MCX future */
  daily: Bar[];
  hourly: Bar[];
  m15: Bar[];
  /** the live future price, if known */
  price?: number;
  confirm: ConfirmInput;
  events: SetupEvent[];
  chain?: Chain | null;
  now: number;
  /** a trade was already taken today: one a day, no adding, no averaging down */
  tradedToday?: boolean;
  /** minutes until the MCX close (no entry when it is closer than the exit rule) */
  minutesToClose?: number;
}

export interface SetupStep {
  id: "trend" | "hourly" | "confirm" | "events" | "trigger" | "strike";
  label: string;
  status: StepStatus;
  detail: string;
}

export interface SetupResult {
  steps: SetupStep[];
  bias: SetupBias;
  side?: DaySide;
  /** ready = every step passes; wait = nothing fails yet but the trigger has not come; no-trade = a step fails */
  verdict: "ready" | "wait" | "no-trade";
  summary: string;
  trend: Trend;
  hourly: Trend;
  levels: Levels;
  trigger: Trigger;
  strike?: SetupStrike;
  /** the invalidation in words, written before entry */
  invalidation?: string;
}

/** The whole checklist, in order. The first failing step decides the verdict; later steps are still shown so the screen says everything it knows. */
export function evaluateSetup(input: SetupInput, r = SETUP_RULES): SetupResult {
  const trend = trendOf(input.daily, r);
  const hourly = trendOf(input.hourly, r);
  const bias = trend.bias;
  const price = input.price ?? input.m15.at(-1)?.close ?? input.hourly.at(-1)?.close ?? NaN;
  const levels = levelsAround(input.hourly, price, r);
  const steps: SetupStep[] = [];

  steps.push({ id: "trend", label: "Daily trend", status: bias === "none" ? "fail" : "pass", detail: bias === "none" ? `No trade: ${trend.reason}` : `${bias}: ${trend.reason}` });

  const against = bias !== "none" && hourly.bias !== "none" && hourly.bias !== bias;
  const lv = `support ${levels.support?.toFixed(1) ?? "none found"}, resistance ${levels.resistance?.toFixed(1) ?? "none found"}`;
  steps.push({ id: "hourly", label: "60-minute trend and levels", status: bias === "none" ? "na" : against ? "fail" : "pass", detail: `${hourly.bias === "none" ? "no clean 60-minute trend" : `60-minute ${hourly.bias}`}; ${lv}${against ? ": the hour is against the day, wait" : ""}` });

  const conf = confirmWithGlobal(bias, input.confirm, r);
  steps.push({ id: "confirm", label: "NYMEX, USD/INR and basis", ...conf });

  const ev = eventFilter(input.events, input.now, r);
  let evStatus = ev.status;
  let evDetail = ev.detail;
  if (evStatus === "pass" && input.minutesToClose !== undefined && input.minutesToClose <= r.exitBeforeCloseMin + 15) {
    evStatus = "fail";
    evDetail = `MCX closes in ${Math.round(input.minutesToClose)} min: no new entry (no overnight hold)`;
  }
  if (evStatus === "pass" && input.tradedToday) {
    evStatus = "fail";
    evDetail = "already traded today: one trade a day, no adding or averaging down";
  }
  steps.push({ id: "events", label: "Event filter", status: evStatus, detail: evDetail });

  let trig = trigger15(input.m15, bias, input.price, r);
  // room: the 60-minute level in the trade's direction must be at least `minRoomR` away
  if (trig.status === "pass" && trig.rPoints) {
    const room = bias === "bullish" ? (levels.resistance === undefined ? Infinity : levels.resistance - trig.entry!) : levels.support === undefined ? Infinity : trig.entry! - levels.support;
    if (room < r.minRoomR * trig.rPoints) trig = { ...trig, status: "fail", detail: `${trig.detail}, but the 60-minute ${bias === "bullish" ? "resistance" : "support"} is only ${(room / trig.rPoints).toFixed(1)}R away` };
  }
  steps.push({ id: "trigger", label: "15-minute trigger", status: trig.status, detail: trig.detail });

  const st = pickStrike(input.chain, bias, trig.status === "pass" ? trig.rPoints : undefined, r);
  steps.push({ id: "strike", label: "Strike", status: st.status, detail: st.detail });

  const failed = steps.find((s) => s.status === "fail");
  const verdict: SetupResult["verdict"] = failed ? "no-trade" : steps.every((s) => s.status === "pass") ? "ready" : "wait";
  const side: DaySide | undefined = bias === "bullish" ? "long" : bias === "bearish" ? "short" : undefined;
  const invalidation =
    trig.status === "pass" && trig.stop !== undefined
      ? `${bias === "bullish" ? "Call" : "Put"} thesis fails if the MCX future trades ${bias === "bullish" ? "below" : "above"} ${trig.stop.toFixed(1)} (the pullback's ${bias === "bullish" ? "low" : "high"}); exit ${r.exitBeforeEventMin} min before a high-impact release and ${r.exitBeforeCloseMin} min before the MCX close.`
      : undefined;
  const summary = failed ? `No trade: ${failed.label.toLowerCase()}. ${failed.detail}` : verdict === "ready" ? `Ready: buy the ${st.pick!.type === "CE" ? "call" : "put"}, ${bias} bias with a 15-minute trigger.` : `Waiting: ${steps.find((s) => s.status === "wait")?.detail ?? "the trigger"}.`;
  return { steps, bias, side, verdict, summary, trend, hourly, levels, trigger: trig, strike: st.pick, invalidation };
}
