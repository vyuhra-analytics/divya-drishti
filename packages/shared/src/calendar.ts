// Economic calendar: the weekly releases that move crude and gas, plus macro events and MCX holidays.
// Pure so the schedule rules (New York time, DST) are unit-tested.
import { tzOffsetSec } from "./index";
import { occurrences, SERIES, seriesByCode, seriesByLegacyKey, zonedTime } from "./eventSeries";
import { weekEndingIso } from "./eventPlan";

export type CalKind = "energy" | "macro" | "holiday";

export interface CalEvent {
  id: string;
  title: string;
  /** epoch ms */
  at: number;
  kind: CalKind;
  impact: "high" | "medium" | "low";
  forecast?: string;
  previous?: string;
  /** the released value, filled in once the official source publishes it */
  actual?: string;
  /** where each filled-in figure came from, shown on hover: provenance for the forecast/previous and the actual */
  src?: { forecast?: string; previous?: string; actual?: string };
  /** set when EIA moved this release from its standard day and time (a holiday): why, and when it would normally have come out */
  delay?: { holiday: string; normalAt: number };
  /** what it moves, as instrument tags: crude, gas, usdinr, mcx (see eventSeries.ts); the Today tab filters on them */
  relevance?: string[];
  /** two-letter market code for the list (US, IN, EA…) */
  country?: string;
  /** the period the figure covers, as a short tag: "OCT/16" for the week ending 16 Oct */
  period?: string;
  /** who publishes it / why it matters, shown under the title */
  detail?: string;
}

interface Release {
  key: string;
  title: string;
  /** 0 = Sunday … 6 = Saturday, in New York */
  weekday: number;
  hour: number;
  minute: number;
  impact: CalEvent["impact"];
  detail: string;
  /** Forex Factory's title for the same release, to borrow its forecast/previous */
  ff?: RegExp;
}

/**
 * The weekly releases, derived from the event dictionary (`eventSeries.ts`) so there is one list of them. Built on first use, not at load:
 * this file and the package index import each other, and the dictionary is not yet defined while that cycle is still loading.
 */
let releasesCache: Release[] | undefined;
const releaseDefs = (): Release[] =>
  (releasesCache ??= SERIES.flatMap((d): Release[] =>
    d.legacyKey && d.schedule.kind === "weekly"
      ? [{ key: d.legacyKey, title: d.title, weekday: d.schedule.weekday, hour: d.schedule.hour, minute: d.schedule.minute, impact: d.importance, detail: d.detail, ff: d.forecastFrom?.title }]
      : [],
  ));

const NY = "America/New_York";
const DAY = 86_400_000;

/** Epoch ms of a New York wall-clock time (DST-aware: the offset is re-read at the resolved instant). */
export function nyTime(year: number, month: number, day: number, hour: number, minute: number): number {
  return zonedTime(NY, year, month, day, hour, minute);
}

/**
 * The recurring US energy releases falling in [from, to), in time order.
 * ponytail: fixed weekday/time. A US holiday that pushes a report a day (EIA after a Monday holiday) is corrected
 * only when Forex Factory's feed lists the release on another day (see mergeForexFactory).
 */
export function energyReleases(from: number, to: number): CalEvent[] {
  const out: CalEvent[] = [];
  for (const def of SERIES) {
    if (def.schedule.kind === "feed") continue; // a feed supplies its own rows
    for (const at of occurrences(def, from, to)) out.push({ id: `${def.legacyKey ?? `ser:${def.code}`}-${at}`, title: def.title, at, kind: def.category === "energy" ? "energy" : "macro", impact: def.importance, detail: def.detail, country: def.legacyKey ? undefined : def.country });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Forex Factory weekly JSON row. */
export interface FFRow {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast?: string;
  previous?: string;
}

const FF_IMPACT: Record<string, CalEvent["impact"]> = { High: "high", Medium: "medium", Low: "low" };

/**
 * Fold Forex Factory into the schedule: its forecast/previous and exact time replace ours for the EIA reports
 * (so a holiday-shifted release lands on the right day); other USD high-impact events and any OPEC item are added.
 */
export function mergeForexFactory(releases: CalEvent[], rows: FFRow[], from: number, to: number): CalEvent[] {
  const out = releases.map((e) => ({ ...e }));
  const used = new Set<FFRow>();
  for (const r of releaseDefs()) {
    if (!r.ff) continue;
    const row = rows.find((x) => x.country === "USD" && r.ff!.test(x.title));
    if (!row) continue;
    used.add(row);
    const at = Date.parse(row.date);
    if (!Number.isFinite(at)) continue;
    const mine = out.find((e) => e.id.startsWith(`${r.key}-`) && Math.abs(e.at - at) < 3 * DAY);
    const patch = { forecast: row.forecast || undefined, previous: row.previous || undefined, src: { forecast: "Forex Factory" } };
    if (mine) Object.assign(mine, { at, id: `${r.key}-${at}` }, patch);
    else if (at >= from && at < to) out.push({ id: `${r.key}-${at}`, title: r.title, at, kind: "energy", impact: r.impact, detail: r.detail, ...patch });
  }
  for (const row of rows) {
    if (used.has(row)) continue;
    const at = Date.parse(row.date);
    if (!Number.isFinite(at) || at < from || at >= to) continue;
    const opec = /\bopec\b/i.test(row.title);
    if (!opec && !(row.country === "USD" && row.impact === "High")) continue;
    out.push({
      id: `ff-${row.country}-${at}-${row.title}`,
      title: opec ? row.title : `${row.title} (US)`,
      at,
      kind: opec ? "energy" : "macro",
      impact: FF_IMPACT[row.impact] ?? "low",
      forecast: row.forecast || undefined,
      previous: row.previous || undefined,
      src: { forecast: "Forex Factory" },
      detail: opec ? "OPEC" : "Moves the dollar, and so crude",
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Upstox /v2/market/holidays row (subset). */
export interface HolidayRow {
  date: string;
  description: string;
  closed_exchanges?: string[];
}

/** MCX full-day holidays in [from, to), placed at the start of that day in IST. */
export function mcxHolidays(rows: HolidayRow[], from: number, to: number): CalEvent[] {
  return rows
    .filter((h) => h.closed_exchanges?.includes("MCX"))
    .map((h): CalEvent => {
      const at = Date.parse(`${h.date}T00:00:00+05:30`);
      return { id: `mcx-${h.date}`, title: `MCX closed: ${h.description}`, at, kind: "holiday", impact: "medium", detail: "Exchange holiday (Upstox)" };
    })
    .filter((e) => Number.isFinite(e.at) && e.at >= from - DAY && e.at < to)
    .sort((a, b) => a.at - b.at);
}

const FF_COUNTRY: Record<string, string> = { USD: "US", EUR: "EA", GBP: "GB", JPY: "JP", CNY: "CN", INR: "IN", CAD: "CA", AUD: "AU" };

/** "OCT/16": the Friday that ends the week a Tuesday-to-Thursday US weekly report covers (the last Friday before the release day). */
export function weekEndingTag(eventAt: number): string {
  const local = new Date(eventAt + tzOffsetSec(NY, eventAt) * 1000);
  const back = ((local.getUTCDay() - 5 + 7) % 7) || 7; // days since the previous Friday, never zero
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back));
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase()}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Market code and period tag for each event, derived from what the event is (id and source), so every list can show them. */
/** An EIA change as the calendar writes it: crude in million barrels with one decimal ("-3.1M"), gas in Bcf ("77B"). */
export const formatEiaChange = (report: "WPSR" | "WNGSR", change: number) => (report === "WPSR" ? `${(Math.round(change * 10) / 10).toFixed(1)}M` : `${Math.round(change)}B`);

/**
 * Fills the "previous" of the two EIA reports that have none (Forex Factory lists only the current week) from the report we stored for the week before
 * that one, never an older one: a release two weeks out has no previous yet. `lookup` returns the headline change of the stored report of exactly that
 * week, or nothing. A figure that is already there is kept.
 */
export async function fillEiaPrevious(events: CalEvent[], lookup: (report: "WPSR" | "WNGSR", weekKey: string) => Promise<number | undefined>): Promise<CalEvent[]> {
  return Promise.all(
    events.map(async (e) => {
      const report = e.id.startsWith("eia-oil-") ? "WPSR" : e.id.startsWith("eia-gas-") ? "WNGSR" : undefined;
      if (!report || e.previous !== undefined) return e;
      const week = new Date(Date.parse(weekEndingIso(e.at)) - 7 * 86_400_000).toISOString().slice(0, 10); // the week the previous report covered
      const change = await lookup(report, week);
      return change === undefined ? e : { ...e, previous: formatEiaChange(report, change), src: { ...e.src, previous: "our stored EIA report" } };
    }),
  );
}

/** What an event moves: the tags of its series, or, for a feed row, by country (US data moves crude and the rupee; Indian data the rupee and MCX). */
export function relevanceOf(e: Pick<CalEvent, "id" | "kind">, country?: string): string[] {
  const legacy = /^(api|eia-oil|eia-gas|rigs|mcx)-/.exec(e.id);
  const series = legacy ? seriesByLegacyKey(legacy[1]) : e.id.startsWith("ser:") ? seriesByCode(/^ser:(.+)-\d+$/.exec(e.id)?.[1] ?? "") : undefined;
  if (series) return series.code === "MCX_HOLIDAY" ? ["crude", "gas", "mcx"] : [...series.relevance];
  if (e.kind === "energy") return ["crude", "gas"]; // OPEC and other energy rows
  return country === "US" ? ["crude", "usdinr"] : country === "IN" ? ["usdinr", "mcx"] : ["usdinr"];
}

/** What the Today tab is about: the tags of the instrument being traded (crude desk: crude, the rupee and MCX itself). */
export const TODAY_FOCUS = { crude: ["crude", "usdinr", "mcx"], gas: ["gas", "usdinr", "mcx"], all: undefined } as const;
export type TodayFocus = keyof typeof TODAY_FOCUS;

/**
 * The events that matter right now for one focus, in time order: from two hours ago (so a release just missed, with its actual, stays) to 24 hours ahead.
 * A holiday counts while its day is near (it has no time of day). `low` impact rows are left out when `bigOnly`.
 */
export function todayEvents(events: CalEvent[], now: number, focus: TodayFocus = "crude", bigOnly = false): CalEvent[] {
  const tags = TODAY_FOCUS[focus];
  return events
    .filter((e) => {
      const near = e.kind === "holiday" ? e.at >= now - 12 * 3600_000 && e.at <= now + 36 * 3600_000 : e.at >= now - 2 * 3600_000 && e.at <= now + 24 * 3600_000;
      return near && (!bigOnly || e.impact !== "low") && (!tags || (e.relevance ?? []).some((t) => (tags as readonly string[]).includes(t)));
    })
    .sort((a, b) => a.at - b.at);
}

/** The first event after `now` that matters for the focus, however far off: what to say when Today is empty. Holidays are skipped. */
export function nextRelevant(events: CalEvent[], now: number, focus: TodayFocus = "crude", bigOnly = false): CalEvent | undefined {
  const tags = TODAY_FOCUS[focus];
  return events
    .filter((e) => e.kind !== "holiday" && e.at > now && (!bigOnly || e.impact !== "low") && (!tags || (e.relevance ?? []).some((t) => (tags as readonly string[]).includes(t))))
    .sort((a, b) => a.at - b.at)[0];
}

export function decorateEvents(events: CalEvent[]): CalEvent[] {
  return events.map((e) => {
    const d = decorateOne(e);
    return { ...d, relevance: relevanceOf(d, d.country) };
  });
}

function decorateOne(e: CalEvent): CalEvent {
  if (/^(api|eia-oil|eia-gas)-/.test(e.id)) return { ...e, country: "US", period: weekEndingTag(e.at) };
  if (e.id.startsWith("rigs-")) return { ...e, country: "US" };
  if (e.id.startsWith("mcx-")) return { ...e, country: "IN" };
  const ff = /^ff-([A-Za-z]+)-/.exec(e.id);
  return ff ? { ...e, country: FF_COUNTRY[ff[1]] ?? "" } : e;
}
