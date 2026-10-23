// EIA's own release schedules for the two weekly reports: the standard day and time plus the official list of exceptions (holidays that move a release),
// read from EIA's pages. This is the authority for when WPSR and WNGSR come out; Forex Factory only had the current week and an unofficial shift.
//   petroleum: https://www.eia.gov/petroleum/supply/weekly/schedule.php  (standard Wednesday 10:30 ET)
//   gas:       https://ir.eia.gov/ngs/schedule.html                       (standard Thursday 10:30 ET)
import type { CalEvent } from "./calendar";
import type { EiaReportCode } from "./eiaReport";
import { weekKey } from "./eiaWatch";
import { weekEndingIso } from "./eventPlan";
import { zonedTime } from "./eventSeries";

const NY = "America/New_York";
const DAY = 86_400_000;

export const EIA_SCHEDULE_URLS = { WPSR: "https://www.eia.gov/petroleum/supply/weekly/schedule.php", WNGSR: "https://ir.eia.gov/ngs/schedule.html" } as const;

export interface EiaScheduleException {
  report: EiaReportCode;
  /** the week the report covers, as the stored calendar keys it (the Friday it ends, YYYY-MM-DD) */
  weekKey: string;
  /** when it would have come out on the standard day and time, epoch ms */
  normalAt: number;
  /** when EIA says it comes out instead, epoch ms */
  at: number;
  holiday: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "January 2, 2025" → [2025, 0, 2] */
function parseDate(s: string): [number, number, number] | undefined {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(s);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return m && month >= 0 ? [Number(m[3]), month, Number(m[2])] : undefined;
}

/** "12:00 p.m." → [12, 0] */
function parseTime(s: string): [number, number] | undefined {
  const m = /(\d{1,2}):(\d{2})\s*([ap])\.?m\./i.exec(s);
  return m ? [(Number(m[1]) % 12) + (m[3].toLowerCase() === "p" ? 12 : 0), Number(m[2])] : undefined;
}

const cells = (row: string) => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => clean(c[1]));

/** Tags out, entities decoded, the replacement character EIA's old encoding leaves in an apostrophe read as one, whitespace collapsed. */
function clean(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#0?39;|&rsquo;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/�/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const rowsOf = (html: string) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => cells(r[1]));

/** Petroleum: columns are the week ending, the alternate release date, the day, the time and the holiday. The standard release is the Wednesday 10:30. */
export function parseEiaPetroleumSchedule(html: string): EiaScheduleException[] {
  return rowsOf(html).flatMap((c): EiaScheduleException[] => {
    const week = c[0] ? parseDate(c[0]) : undefined;
    const rel = c[1] ? parseDate(c[1]) : undefined;
    const time = c[3] ? parseTime(c[3]) : undefined;
    if (c.length < 5 || !week || !rel || !time) return [];
    const periodEnd = Date.UTC(...week);
    return [{ report: "WPSR", weekKey: weekKey(periodEnd), normalAt: zonedTime(NY, week[0], week[1], week[2] + 5, 10, 30), at: zonedTime(NY, ...rel, ...time), holiday: c[4] }];
  });
}

/**
 * Gas: columns are the alternate release date, the day, the time and the holiday; the standard release is Thursday 10:30. The Thursday it replaces is the
 * one nearest the new date: the day after a Wednesday, the day before a Friday, the Thursday before a Monday or Tuesday.
 */
export function parseEiaGasSchedule(html: string): EiaScheduleException[] {
  return rowsOf(html).flatMap((c): EiaScheduleException[] => {
    const rel = c[0] ? parseDate(c[0]) : undefined;
    const time = c[2] ? parseTime(c[2]) : undefined;
    if (c.length < 4 || !rel || !time) return [];
    const date = Date.UTC(...rel);
    const dow = new Date(date).getUTCDay(); // 0 Sunday
    const back = dow === 3 ? -1 : dow === 5 ? 1 : dow === 1 ? 4 : dow === 2 ? 5 : dow === 4 ? 0 : undefined;
    if (back === undefined) return [];
    const thursday = new Date(date - back * DAY);
    const normalAt = zonedTime(NY, thursday.getUTCFullYear(), thursday.getUTCMonth(), thursday.getUTCDate(), 10, 30);
    return [{ report: "WNGSR", weekKey: weekEndingIso(normalAt), normalAt, at: zonedTime(NY, ...rel, ...time), holiday: c[3] }];
  });
}

const ET = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: NY });

/**
 * Puts EIA's official times on the two EIA events of a calendar list. An event that EIA moved gets the new time, a `delay` (the holiday and when it
 * would normally have come out) and a line in its detail; the id follows the time so a moved release is never listed twice. Other events are untouched.
 */
export function applyEiaSchedule(events: CalEvent[], exceptions: EiaScheduleException[]): CalEvent[] {
  return events.map((e) => {
    const prefix = e.id.startsWith("eia-oil-") ? "eia-oil" : e.id.startsWith("eia-gas-") ? "eia-gas" : undefined;
    if (!prefix) return e;
    const report: EiaReportCode = prefix === "eia-oil" ? "WPSR" : "WNGSR";
    const key = weekEndingIso(e.at);
    const x = exceptions.find((d) => d.report === report && d.weekKey === key);
    if (!x) return e;
    return {
      ...e,
      id: `${prefix}-${x.at}`,
      at: x.at,
      delay: { holiday: x.holiday, normalAt: x.normalAt },
      detail: `${e.detail ?? ""}${e.detail ? " · " : ""}EIA moved it for ${x.holiday}: normally ${ET.format(x.normalAt)} ET`,
    };
  });
}

/** The exceptions still ahead (or in the last day), soonest first: the "next delay" line. */
export const upcomingExceptions = (all: EiaScheduleException[], now: number) => all.filter((x) => x.at >= now - DAY).sort((a, b) => a.at - b.at);
