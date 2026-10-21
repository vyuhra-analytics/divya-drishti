// Energy recap: a short fixed-template summary of an instrument from numbers we already have. No model, no key, works offline.
// Every sentence comes from one rule with one threshold, so what it says can be traced to a number. Pure and tested.
import type { BriefingContext } from "./briefing";
import type { CurveSummary } from "./curve";
import { instrument } from "./index";

export interface RecapExtras {
  curve?: CurveSummary;
  /** managed-money (speculator) positioning for the matching CFTC market */
  cot?: { name: string; net: number; change?: number; percentile?: number };
  /** latest weekly EIA stock readings, in thousand barrels */
  stocks?: { label: string; change?: number; vsFiveYear?: number }[];
}

export interface Recap {
  headline: string;
  lines: string[];
}

const signed = (v: number, d = 2) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
const grouped = (v: number) => Math.round(Math.abs(v)).toLocaleString("en-US");

function eta(min: number): string {
  const a = Math.abs(min);
  const t = a < 60 ? `${a} min` : a < 2880 ? `${Math.floor(a / 60)} h ${a % 60} min` : `${Math.round(a / 1440)} days`;
  return min >= 0 ? `in ${t}` : `${t} ago`;
}

/** Build the recap. Anything missing from the inputs is left out, never guessed. */
export function buildRecap(ctx: BriefingContext, extras: RecapExtras = {}): Recap {
  const d = instrument(ctx.symbol)?.decimals ?? 2;
  const lines: string[] = [];
  const { day, technicals: t, stats: s } = ctx;

  // headline: price, day move, where it sits in the day's range
  let where = "";
  if (day.high !== undefined && day.low !== undefined && day.high > day.low) {
    const pos = (ctx.price - day.low) / (day.high - day.low);
    where = pos >= 0.8 ? ", near the day high" : pos <= 0.2 ? ", near the day low" : ", mid-range for the day";
  }
  const headline = `${ctx.name} is at ${ctx.price.toFixed(d)}${ctx.changePct !== undefined ? ` (${signed(ctx.changePct)}% on the day)` : ""}${where}.`;

  // how much to trust the price: a closed, quiet, delayed or disputed feed is said so before anything else
  const pv = ctx.provenance?.price;
  if (pv?.quality === "closed") lines.push("The market is closed: this is the last price, not a live one.");
  else if (pv?.quality === "stale") lines.push("The feed has gone quiet: this price may be behind the market.");
  else if (pv?.quality === "delayed") lines.push(`This price comes from ${pv.source}, which runs behind the exchange.`);
  if (pv?.conflict) lines.push(`Two live feeds disagree: ${pv.conflict.between.join(" and ")} differ by ${pv.conflict.pct.toFixed(2)}%, so treat the price as disputed.`);

  // trend and momentum from the chart timeframe
  if (t.ema20 !== undefined && t.ema50 !== undefined) {
    const trend = ctx.price > t.ema20 && ctx.price > t.ema50 ? "above both its 20 and 50 period averages (uptrend)" : ctx.price < t.ema20 && ctx.price < t.ema50 ? "below both its 20 and 50 period averages (downtrend)" : "between its 20 and 50 period averages (no clear trend)";
    const rsi = t.rsi14 === undefined ? "" : t.rsi14 >= 70 ? `; RSI ${t.rsi14.toFixed(0)} is overbought` : t.rsi14 <= 30 ? `; RSI ${t.rsi14.toFixed(0)} is oversold` : `; RSI ${t.rsi14.toFixed(0)}`;
    lines.push(`On the ${t.timeframe} chart price is ${trend}${rsi}.`);
  }

  // volatility
  if (s.volPercentile !== undefined && s.realizedVol20 !== undefined) {
    const level = s.volPercentile >= 80 ? "high" : s.volPercentile <= 20 ? "low" : "normal";
    lines.push(`Volatility is ${level} for the loaded history (${s.volPercentile.toFixed(0)}th percentile, ${s.realizedVol20.toFixed(0)}% annualised)${s.regime && s.regime !== "random" ? `, and price has been ${s.regime}` : ""}.`);
  }

  // curve
  if (extras.curve?.m1m2 !== undefined) {
    const c = extras.curve;
    lines.push(`The futures curve is in ${c.shape}: the next month is ${signed(c.m1m2!, d)} against the front${c.shape === "backwardation" ? " (later months cheaper, a tight market)" : c.shape === "contango" ? " (later months dearer)" : ""}.`);
  }

  // positioning
  if (extras.cot) {
    const k = extras.cot;
    const side = k.net >= 0 ? "long" : "short";
    lines.push(
      `Speculators are net ${side} ${grouped(k.net)} contracts in ${k.name}${k.percentile !== undefined ? `, the ${k.percentile.toFixed(0)}th percentile of the last three years` : ""}${k.change !== undefined ? `, ${k.change >= 0 ? "adding" : "cutting"} ${grouped(k.change)} on the week` : ""}.`,
    );
  }

  // inventories
  for (const k of extras.stocks ?? []) {
    if (k.change === undefined) continue;
    lines.push(`${k.label} ${k.change < 0 ? "drew" : k.change > 0 ? "built" : "were unchanged"}${k.change !== 0 ? ` ${grouped(k.change)} thousand barrels` : ""} last week${k.vsFiveYear !== undefined ? `, ${grouped(k.vsFiveYear)} thousand ${k.vsFiveYear < 0 ? "below" : "above"} the five-year average` : ""}.`);
  }

  // options
  if (ctx.options?.pcr !== undefined) {
    lines.push(`Options: put/call ratio ${ctx.options.pcr.toFixed(2)}${ctx.options.maxPain !== undefined ? `, max pain ${ctx.options.maxPain}` : ""}.`);
  }

  // next scheduled release
  const next = ctx.events.find((e) => e.inMin >= 0);
  if (next) lines.push(`Next release: ${next.title} ${eta(next.inMin)}${next.forecast ? ` (forecast ${next.forecast}${next.previous ? `, previous ${next.previous}` : ""})` : ""}.`);

  // freshest headline for this contract
  const recent = ctx.news.filter((n) => n.ageMin <= 180);
  if (recent.length) lines.push(`${recent.length} headline${recent.length === 1 ? "" : "s"} in the last 3 hours; newest: "${recent[0].title}" (${recent[0].source}, ${eta(-recent[0].ageMin)}).`);

  return { headline, lines };
}
