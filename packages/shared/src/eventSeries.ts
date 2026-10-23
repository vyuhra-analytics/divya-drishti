// The economic calendar's dictionary: every KIND of event we track is one entry in SERIES, and everything else (the occurrence generator, the
// recorder, the stored tables, the panel) works from that list. To add an event, add an entry here (and, when its actual value comes from a
// new place, an actual source in the recorder): nothing else changes. See docs/EVENTS.md for worked examples (RBI MPC minutes, India FX reserves).
import { tzOffsetSec } from "./index";

export type EventCategory = "energy" | "macro" | "central_bank" | "holiday" | "data";
export type Importance = "high" | "medium" | "low";

/**
 * How occurrences of a series come about:
 *  - weekly: a fixed weekday and wall-clock time in a time zone (EIA, API, Baker Hughes; India FX reserves would be one);
 *  - dates: an explicit list of instants (a central bank's published meeting calendar; RBI MPC minutes would be one);
 *  - feed: a source supplies them (Forex Factory, Upstox holidays); the series is only the home for what the feed brings.
 */
export type ScheduleRule =
  | { kind: "weekly"; tz: string; weekday: number; hour: number; minute: number }
  | { kind: "dates"; at: readonly number[] }
  | { kind: "feed"; feed: string };

export interface EventSeriesDef {
  /** stable code, the primary key in the database: upper snake case (WPSR) or `FF:US:CORE_CPI_M_M` for a feed-born series */
  code: string;
  /** the id prefix the calendar panel's events have always carried (`eia-oil`): kept so existing event ids and tests keep working */
  legacyKey?: string;
  title: string;
  category: EventCategory;
  /** two-letter market code (US, IN, EA…) */
  country: string;
  importance: Importance;
  frequency: "weekly" | "monthly" | "quarterly" | "irregular" | "daily";
  detail: string;
  /** what it matters to: instrument tags (`crude`, `gas`, `usdinr`, `mcx`, `all`), so a view can be "everything that moves my instruments" */
  relevance: readonly string[];
  /** who publishes it */
  source: string;
  schedule: ScheduleRule;
  /** the Forex Factory row that carries this series' forecast and previous values (matched by country and title) */
  forecastFrom?: { country: string; title: RegExp };
  /** how each secondary source names this event: source id (`financecalendar`, `yahoo`) to a pattern for that source's own code (see calendarSources.ts) */
  aliases?: Partial<Record<string, RegExp>>;
}

const NY = "America/New_York";

/** The series we define ourselves, with their schedules. Forex Factory rows become `FF:` series on first sight (see `autoSeries`). */
export const SERIES: EventSeriesDef[] = [
  { code: "API", legacyKey: "api", title: "API crude inventories", category: "energy", country: "US", importance: "medium", frequency: "weekly", detail: "American Petroleum Institute, weekly", relevance: ["crude"], source: "American Petroleum Institute", schedule: { kind: "weekly", tz: NY, weekday: 2, hour: 16, minute: 30 } },
  { code: "WPSR", legacyKey: "eia-oil", title: "EIA crude inventories", category: "energy", country: "US", importance: "high", frequency: "weekly", detail: "EIA Weekly Petroleum Status Report", relevance: ["crude"], source: "EIA", schedule: { kind: "weekly", tz: NY, weekday: 3, hour: 10, minute: 30 }, forecastFrom: { country: "USD", title: /^crude oil inventories$/i }, aliases: { financecalendar: /^us-eia-petroleum$/ } },
  { code: "WNGSR", legacyKey: "eia-gas", title: "EIA natural gas storage", category: "energy", country: "US", importance: "high", frequency: "weekly", detail: "EIA weekly storage report", relevance: ["gas"], source: "EIA", schedule: { kind: "weekly", tz: NY, weekday: 4, hour: 10, minute: 30 }, forecastFrom: { country: "USD", title: /^natural gas storage$/i }, aliases: { financecalendar: /^us-eia-natural-gas$/, yahoo: /^EIA-Nat Gas Chg/ } },
  { code: "RIGS", legacyKey: "rigs", title: "Baker Hughes rig count", category: "energy", country: "US", importance: "medium", frequency: "weekly", detail: "US oil and gas rigs, weekly", relevance: ["crude", "gas"], source: "Baker Hughes", schedule: { kind: "weekly", tz: NY, weekday: 5, hour: 13, minute: 0 } },
  { code: "MCX_HOLIDAY", legacyKey: "mcx", title: "MCX closed", category: "holiday", country: "IN", importance: "medium", frequency: "irregular", detail: "Exchange holiday (Upstox)", relevance: ["mcx"], source: "Upstox", schedule: { kind: "feed", feed: "upstox-holidays" } },
];

export const seriesByCode = (code: string) => SERIES.find((s) => s.code === code);
export const seriesByLegacyKey = (key: string) => SERIES.find((s) => s.legacyKey === key);

/** Epoch ms of a wall-clock time in a zone (DST-aware: the offset is re-read at the resolved instant). `month` is 0-based. */
export function zonedTime(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - tzOffsetSec(tz, guess) * 1000;
  return guess - tzOffsetSec(tz, first) * 1000;
}

const DAY = 86_400_000;

/**
 * The instants a series generates inside [from, to), oldest first. A `feed` series generates none (its feed supplies them); a `dates` series
 * returns the listed instants in the window; a `weekly` one returns the weekday at the wall-clock time in its zone, across daylight saving.
 */
export function occurrences(def: EventSeriesDef, from: number, to: number): number[] {
  const rule = def.schedule;
  if (rule.kind === "feed") return [];
  if (rule.kind === "dates") return rule.at.filter((t) => t >= from && t < to).sort((a, b) => a - b);
  const out: number[] = [];
  const start = new Date(from + tzOffsetSec(rule.tz, from) * 1000); // "today" in that zone, as UTC fields
  for (let d = -1; d <= Math.ceil((to - from) / DAY) + 1; d++) {
    const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + d));
    if (day.getUTCDay() !== rule.weekday) continue;
    const at = zonedTime(rule.tz, day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), rule.hour, rule.minute);
    if (at >= from && at < to) out.push(at);
  }
  return out;
}

/** "Core CPI m/m (US)" → CORE_CPI_M_M: a stable, readable code part for a title. */
export const slug = (title: string) =>
  title
    .replace(/\s*\((?:US|IN|EA|GB|JP|CN|CA|AU)\)\s*$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

const FF_COUNTRY: Record<string, string> = { USD: "US", EUR: "EA", GBP: "GB", JPY: "JP", CNY: "CN", INR: "IN", CAD: "CA", AUD: "AU" };

/** A series born from a feed row we had no definition for: its code names the feed's country and title, so the same row always lands in the same series. */
export function autoSeries(feedCountry: string, title: string, importance: Importance, category: EventCategory = "macro"): EventSeriesDef {
  const country = FF_COUNTRY[feedCountry] ?? feedCountry.slice(0, 2).toUpperCase();
  const relevance = category === "energy" ? ["crude", "gas"] : country === "US" ? ["crude", "usdinr"] : country === "IN" ? ["usdinr", "mcx"] : ["usdinr"];
  return {
    code: `FF:${country}:${slug(title)}`,
    title: title.replace(/\s*\((?:US|IN|EA|GB|JP|CN|CA|AU)\)\s*$/i, ""),
    category,
    country,
    importance,
    frequency: "irregular",
    detail: category === "energy" ? "OPEC" : "Moves the dollar, and so crude",
    relevance,
    source: "Forex Factory",
    schedule: { kind: "feed", feed: "forexfactory" },
  };
}

/** A figure as published ("-4.6M", "5.2%", "250K", "3,567", "2.75|2.9") → its number and unit; undefined text or no number gives no number. */
export function parseValue(text: string | undefined): { num?: number; unit?: string } {
  if (!text) return {};
  const m = /^\s*([<>≤≥]?)\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*([A-Za-z%]*)/.exec(text);
  if (!m) return {};
  const num = Number(m[2].replace(/,/g, ""));
  return Number.isFinite(num) ? { num, ...(m[3] ? { unit: m[3] } : {}) } : {};
}
