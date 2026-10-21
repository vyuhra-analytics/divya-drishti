// Provenance: where a number came from, how good it is, and when the underlying data is from. Attached to quotes (via the stream),
// to the facts the AI briefing receives, and used for freshness budgets: how old each kind of data may be before it is "outdated".
// Pure and tested.
import type { Quote } from "./index";
import type { Freshness } from "./sessions";

export type Quality = "live" | "delayed" | "stale" | "closed" | "computed" | "published";

export interface Provenance {
  /** upstox, tradingview, yahoo, computed, eia, cftc, ... */
  source: string;
  quality: Quality;
  /** when the underlying data is from (epoch ms): the quote time, the last bar's close, the report's date */
  asOf: number;
  /** another live source disagrees by more than DRIFT_FLAG_PCT: this price may be wrong */
  conflict?: { between: [string, string]; pct: number; ticks: number };
}

/** What kind of data, for the freshness budget. */
export type DataKind = "quote" | "bars" | "options" | "curve" | "calendar" | "news" | "positioning" | "inventory" | "spot" | "transits" | "balances";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How old data of each kind may be before it counts as outdated. Weekly reports get a day or two of slack past their cadence. */
export const FRESHNESS_BUDGET_MS: Record<DataKind, number> = {
  quote: MIN, // the stream's own staleness rule
  bars: 2 * HOUR, // history refreshes with the chart; older than this and the chart is not following the market
  options: 30_000,
  curve: 2 * MIN,
  calendar: 2 * HOUR,
  news: 6 * HOUR,
  positioning: 9 * DAY, // COT: weekly, published Friday for the Tuesday before (up to 10 days old at the next release)
  inventory: 9 * DAY, // EIA weekly
  spot: 5 * DAY, // EIA daily spot prices: a long weekend plus EIA's own delay
  transits: 14 * DAY, // PortWatch: weekly, a few days behind
  balances: 270 * DAY, // JODI: countries report up to ~8 months late
};

export const withinBudget = (kind: DataKind, asOf: number, now: number) => now - asOf <= FRESHNESS_BUDGET_MS[kind];

/** Provenance of a live quote from its source, delay and the session/feed state. */
export function quoteProvenance(q: Pick<Quote, "source" | "time" | "delayedBy" | "drift">, fresh: Freshness): Provenance {
  const quality: Quality = fresh === "closed" ? "closed" : fresh === "stale" ? "stale" : (q.delayedBy ?? 0) > 0 ? "delayed" : "live";
  return { source: q.source, quality, asOf: q.time, ...(q.drift ? { conflict: { between: q.drift.between, pct: q.drift.pct, ticks: q.drift.ticks } } : {}) };
}

/** Facts computed here from bars (indicators, volatility): their as-of is the close of the last bar used. */
export const computedProvenance = (asOf: number): Provenance => ({ source: "computed", quality: "computed", asOf });

/** Plain words for a badge or tooltip. */
export function describeProvenance(p: Provenance, now: number): string {
  const age = Math.max(0, Math.round((now - p.asOf) / 1000));
  const ago = age < 90 ? `${age}s ago` : age < 5400 ? `${Math.round(age / 60)}m ago` : age < 172_800 ? `${Math.round(age / 3600)}h ago` : `${Math.round(age / 86_400)}d ago`;
  const conflict = p.conflict ? `; ${p.conflict.between.join(" and ")} differ by ${p.conflict.pct.toFixed(2)}% (${p.conflict.ticks} ticks)` : "";
  return `${p.source}, ${p.quality}, as of ${ago}${conflict}`;
}
