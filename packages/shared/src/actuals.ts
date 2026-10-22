// Released "actual" values for calendar events. Forex Factory's free feed carries schedule, forecast and previous but never the
// actual, so the actual comes from the official source once it is published: EIA's own weekly files for the two EIA reports
// (the same files the headline numbers come from) and FRED's keyless CSV for the main US macro releases.
// Pure parsing and freshness rules; the controller fetches the files. The freshness rule is the important part: a file that
// still holds LAST week's numbers must not be shown as this week's actual.
import type { CalEvent } from "./calendar";
import { tzOffsetSec } from "./index";

const DAY = 86_400_000;

/** One CSV line with quoted fields ("3,567") split into cells. */
export function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line.replace(/^﻿/, "")) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) (out.push(cur), (cur = ""));
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const toNum = (s: string | undefined) => {
  const n = Number((s ?? "").replace(/,/g, "").trim());
  return s !== undefined && s.trim() !== "" && Number.isFinite(n) ? n : undefined;
};

/** "10/9/26" → UTC midnight of that day (week-ending dates in the petroleum file). */
function mdyShort(s: string): number | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s.trim());
  if (!m) return undefined;
  const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  return Date.UTC(year, Number(m[1]) - 1, Number(m[2]));
}

export interface Wpsr {
  /** the week the figures are for (a Friday), UTC midnight */
  weekEnding: number;
  /** row name → week-over-week change, million barrels */
  change: Record<string, number>;
}

/** EIA Weekly Petroleum Status Report, table 1 (`ir.eia.gov/wpsr/table1.csv`): stocks this week, last week and the difference. */
export function parseWpsr(csv: string): Wpsr | undefined {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = lines.length ? csvCells(lines[0]) : [];
  const weekEnding = head[1] ? mdyShort(head[1]) : undefined;
  const diffAt = head.findIndex((h) => h === "Difference");
  if (weekEnding === undefined || diffAt < 0) return undefined;
  const change: Record<string, number> = {};
  for (const l of lines.slice(1)) {
    const c = csvCells(l);
    const d = toNum(c[diffAt]);
    if (c[0] && d !== undefined) change[c[0]] = d;
  }
  return { weekEnding, change };
}

export interface Wngsr {
  weekEnding: number;
  /** Lower 48 net change in working gas, Bcf */
  netChange: number;
}

/** EIA Weekly Natural Gas Storage Report (`ir.eia.gov/ngs/wngsr.csv`): the "Total" row's net change. */
export function parseWngsr(csv: string): Wngsr | undefined {
  const lines = csv.split(/\r?\n/);
  const we = /Week Ending ([A-Za-z]+ \d{1,2}, \d{4})/.exec(lines.join("\n"));
  const weekEnding = we ? Date.parse(`${we[1]} UTC`) : NaN;
  const header = lines.map(csvCells).find((c) => c.some((x) => /net change/i.test(x)));
  const at = header?.findIndex((x) => /net change/i.test(x)) ?? -1;
  const total = lines.map(csvCells).find((c) => c[0] === "Total");
  const netChange = total && at >= 0 ? toNum(total[at]) : undefined;
  return Number.isFinite(weekEnding) && netChange !== undefined ? { weekEnding, netChange } : undefined;
}

/** UTC midnight of the New York calendar day an instant falls on. */
const etDay = (ms: number) => {
  const local = new Date(ms + tzOffsetSec("America/New_York", ms) * 1000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
};

/**
 * A weekly EIA file belongs to an event when its week-ending date is within the 7 days before the release day: the report
 * published on Wednesday covers the Friday before, a holiday-shifted one a day or two later. Older than that = last week's file.
 */
export const fileIsForEvent = (weekEnding: number, eventAt: number) => {
  const day = etDay(eventAt);
  return weekEnding >= day - 7 * DAY && weekEnding < day;
};

const signed = (n: number, digits: number) => (Object.is(n, -0) ? 0 : n).toFixed(digits);

/**
 * Fill `actual` on the EIA events whose release time has passed and whose file now holds that week's numbers.
 * Crude uses the commercial (excluding SPR) change, which is the headline figure the forecast and "previous" refer to.
 * Events already carrying an actual, and events not yet released, are left alone.
 */
export function applyEiaActuals(events: CalEvent[], files: { wpsr?: Wpsr; wngsr?: Wngsr }, now: number): CalEvent[] {
  return events.map((e) => {
    if (e.actual !== undefined || e.at > now) return e;
    if (e.id.startsWith("eia-oil-") && files.wpsr && fileIsForEvent(files.wpsr.weekEnding, e.at)) {
      const d = files.wpsr.change["Commercial (Excluding SPR)"];
      if (d !== undefined) return { ...e, actual: `${signed(d, 1)}M`, src: { ...e.src, actual: "EIA weekly report (ir.eia.gov)" } };
    }
    if (e.id.startsWith("eia-gas-") && files.wngsr && fileIsForEvent(files.wngsr.weekEnding, e.at)) return { ...e, actual: `${signed(files.wngsr.netChange, 0)}B`, src: { ...e.src, actual: "EIA gas storage report (ir.eia.gov)" } };
    return e;
  });
}

// ---- every figure in the two EIA files, for the stored calendar (one row per series per report) ----

/** One figure of an EIA report: a stock level with last week's and the change. Units: WPSR million barrels, WNGSR billion cubic feet. */
export interface EiaReportPoint {
  /** `WPSR:COMMERCIAL_EXCLUDING_SPR`, `WNGSR:SOUTH_CENTRAL`: the report and a slug of the row name */
  seriesId: string;
  label: string;
  unit: string;
  /** the week the report covers, UTC midnight */
  periodEnd: number;
  value: number;
  prior?: number;
  change?: number;
  /** the figure the forecast and the market quote (commercial crude stocks excluding SPR; total Lower 48 gas storage) */
  headline: boolean;
}

const slugRow = (label: string) =>
  label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** The stocks table of the EIA petroleum report (the first block of `table1.csv`: crude, gasoline, distillate, jet, propane, totals): every row as a point. */
export function wpsrPoints(csv: string): EiaReportPoint[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = lines.length ? csvCells(lines[0]) : [];
  const periodEnd = head[1] ? mdyShort(head[1]) : undefined;
  if (periodEnd === undefined || head[0] !== "STUB_1") return [];
  const out: EiaReportPoint[] = [];
  for (const l of lines.slice(1)) {
    const c = csvCells(l);
    if (c[0] === "STUB_1") break; // the second block (supply and demand) has other columns
    const value = toNum(c[1]);
    if (!c[0] || value === undefined) continue;
    const label = c[0].trim();
    out.push({ seriesId: `WPSR:${slugRow(label)}`, label, unit: "million barrels", periodEnd, value, prior: toNum(c[2]), change: toNum(c[3]), headline: label === "Commercial (Excluding SPR)" });
  }
  return out;
}

/** The regional table of the EIA natural gas storage report (`wngsr.csv`): East, Midwest, Mountain, Pacific, South Central (with Salt and Nonsalt) and the Lower 48 total. */
export function wngsrPoints(csv: string): EiaReportPoint[] {
  const we = /Week Ending ([A-Za-z]+ \d{1,2}, \d{4})/.exec(csv);
  const periodEnd = we ? Date.parse(`${we[1]} UTC`) : NaN;
  const rows = csv.split(/\r?\n/).map(csvCells);
  const header = rows.find((c) => c.some((x) => /net change/i.test(x)));
  const changeAt = header?.findIndex((x) => /net change/i.test(x)) ?? -1;
  const isDate = (x: string | undefined) => /^\d{2}-[A-Za-z]{3}-\d{2}$/.test(x ?? "");
  const dates = rows.find((c) => isDate(c[1]) && isDate(c[4]));
  if (!Number.isFinite(periodEnd) || changeAt < 0 || !dates) return [];
  const regions = new Set(["East", "Midwest", "Mountain", "Pacific", "South Central", "Salt", "Nonsalt", "Total"]);
  const out: EiaReportPoint[] = [];
  for (const c of rows) {
    const label = (c[0] ?? "").trim();
    const value = toNum(c[1]);
    if (!regions.has(label) || value === undefined) continue;
    out.push({ seriesId: `WNGSR:${slugRow(label)}`, label, unit: "Bcf", periodEnd, value, prior: toNum(c[4]), change: toNum(c[changeAt]), headline: label === "Total" });
  }
  return out;
}

// ---- FRED, for the US macro events Forex Factory lists ----

export interface SeriesPoint {
  date: string;
  value: number;
}

/** FRED `fredgraph.csv` → points (header row dropped, missing values "." skipped). */
export function parseFredCsv(csv: string, lastN = 60): SeriesPoint[] {
  const pts: SeriesPoint[] = [];
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const [date, raw] = line.split(",");
    const value = Number(raw);
    if (date && Number.isFinite(value) && raw !== "") pts.push({ date, value });
  }
  return pts.slice(-lastN);
}

type Kind = "level" | "mom_pct" | "yoy_pct" | "change";
interface Matcher {
  test: (title: string, country: string) => boolean;
  seriesId: string;
  kind: Kind;
  /** "rate" series update the day of the decision; "monthly" ones carry the previous month's period date */
  cadence: "rate" | "monthly";
}

/** The US releases worth a column of actuals; anything else keeps forecast and previous only. */
export const FRED_MATCHERS: Matcher[] = [
  { test: (t, c) => c === "USD" && /federal funds rate/i.test(t), seriesId: "DFEDTARU", kind: "level", cadence: "rate" },
  { test: (t, c) => c === "USD" && /non-?farm employment change/i.test(t), seriesId: "PAYEMS", kind: "change", cadence: "monthly" },
  { test: (t, c) => c === "USD" && /^unemployment rate$/i.test(t), seriesId: "UNRATE", kind: "level", cadence: "monthly" },
  { test: (t, c) => c === "USD" && /^core cpi y\/y$/i.test(t), seriesId: "CPILFESL", kind: "yoy_pct", cadence: "monthly" },
  { test: (t, c) => c === "USD" && /^core cpi m\/m$/i.test(t), seriesId: "CPILFESL", kind: "mom_pct", cadence: "monthly" },
  { test: (t, c) => c === "USD" && /^cpi y\/y$/i.test(t), seriesId: "CPIAUCSL", kind: "yoy_pct", cadence: "monthly" },
  { test: (t, c) => c === "USD" && /^cpi m\/m$/i.test(t), seriesId: "CPIAUCSL", kind: "mom_pct", cadence: "monthly" },
];

/** The FRED series (if any) that answers a Forex Factory event title. */
export const fredSeriesFor = (title: string, country = "USD") => FRED_MATCHERS.find((m) => m.test(title, country));

const sameMonth = (a: number, b: number) => new Date(a).getUTCFullYear() === new Date(b).getUTCFullYear() && new Date(a).getUTCMonth() === new Date(b).getUTCMonth();

/**
 * The released figure for an event from its FRED series, or undefined while FRED still holds an older reading.
 * Monthly releases report the month before the release date, so freshness is judged against that reference month;
 * rate decisions must have caught up to the decision date.
 */
export function fredActual(title: string, country: string, eventAt: number, now: number, points: SeriesPoint[]): string | undefined {
  const m = fredSeriesFor(title, country);
  if (!m || eventAt > now || points.length === 0) return undefined;
  const last = points[points.length - 1];
  const lastAt = Date.parse(`${last.date}T00:00:00Z`);
  const eventDay = new Date(eventAt);
  if (m.cadence === "rate") {
    if (lastAt < eventAt - 3 * DAY) return undefined;
  } else if (!sameMonth(lastAt, Date.UTC(eventDay.getUTCFullYear(), eventDay.getUTCMonth() - 1, 1))) return undefined;

  const prev = points[points.length - 2];
  if (m.kind === "level") return `${last.value.toFixed(2)}%`;
  if (m.kind === "change") return prev ? `${Math.round(last.value - prev.value)}K` : undefined;
  if (m.kind === "mom_pct") return prev ? `${(((last.value - prev.value) / prev.value) * 100).toFixed(1)}%` : undefined;
  const yearAgo = [...points].reverse().find((p) => lastAt - Date.parse(`${p.date}T00:00:00Z`) >= 360 * DAY);
  return yearAgo ? `${(((last.value - yearAgo.value) / yearAgo.value) * 100).toFixed(1)}%` : undefined;
}

/** True while some release is due or just out and has no actual yet: the calendar should refresh often. */
export function releasePending(events: CalEvent[], now: number): boolean {
  return events.some((e) => e.kind !== "holiday" && e.actual === undefined && e.at > now - 6 * 3600_000 && e.at < now + 10 * 60_000 && e.impact !== "low");
}
