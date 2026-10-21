// Energy calendar: the weekly releases that move crude and gas, plus macro events and MCX holidays.
// Pure so the schedule rules (New York time, DST) are unit-tested.
import { tzOffsetSec } from "./index";

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

const RELEASES: Release[] = [
  { key: "api", title: "API crude inventories", weekday: 2, hour: 16, minute: 30, impact: "medium", detail: "American Petroleum Institute, weekly" },
  { key: "eia-oil", title: "EIA crude inventories", weekday: 3, hour: 10, minute: 30, impact: "high", detail: "EIA Weekly Petroleum Status Report", ff: /^crude oil inventories$/i },
  { key: "eia-gas", title: "EIA natural gas storage", weekday: 4, hour: 10, minute: 30, impact: "high", detail: "EIA weekly storage report", ff: /^natural gas storage$/i },
  { key: "rigs", title: "Baker Hughes rig count", weekday: 5, hour: 13, minute: 0, impact: "medium", detail: "US oil and gas rigs, weekly" },
];

const NY = "America/New_York";
const DAY = 86_400_000;

/** Epoch ms of a New York wall-clock time (DST-aware: the offset is re-read at the resolved instant). */
export function nyTime(year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - tzOffsetSec(NY, guess) * 1000;
  return guess - tzOffsetSec(NY, first) * 1000;
}

/**
 * The recurring US energy releases falling in [from, to), in time order.
 * ponytail: fixed weekday/time. A US holiday that pushes a report a day (EIA after a Monday holiday) is corrected
 * only when Forex Factory's feed lists the release on another day (see mergeForexFactory).
 */
export function energyReleases(from: number, to: number): CalEvent[] {
  const out: CalEvent[] = [];
  const start = new Date(from + tzOffsetSec(NY, from) * 1000); // New York "today" as UTC fields
  for (let d = -1; d <= Math.ceil((to - from) / DAY) + 1; d++) {
    const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + d));
    for (const r of RELEASES) {
      if (day.getUTCDay() !== r.weekday) continue;
      const at = nyTime(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), r.hour, r.minute);
      if (at >= from && at < to) out.push({ id: `${r.key}-${at}`, title: r.title, at, kind: "energy", impact: r.impact, detail: r.detail });
    }
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
  for (const r of RELEASES) {
    if (!r.ff) continue;
    const row = rows.find((x) => x.country === "USD" && r.ff!.test(x.title));
    if (!row) continue;
    used.add(row);
    const at = Date.parse(row.date);
    if (!Number.isFinite(at)) continue;
    const mine = out.find((e) => e.id.startsWith(`${r.key}-`) && Math.abs(e.at - at) < 3 * DAY);
    const patch = { forecast: row.forecast || undefined, previous: row.previous || undefined };
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
