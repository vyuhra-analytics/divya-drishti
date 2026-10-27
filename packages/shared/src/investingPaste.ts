// History of an Investing.com economic-calendar event that a PERSON copied from the page (after pressing "Show more" in their own browser) and saved as
// text: one line per release, "Oct 21, 2026 14:30 -3.060M -0.100M -8.557M" (date, time, actual, forecast, previous), with tabs between the cells when
// copied from the table. The page shows times in the viewer's time zone, so the zone is a parameter (UTC or America/New_York). Pure and tested.
import { zonedTime } from "./eventSeries";

export interface PastedOccurrence {
  /** the release, epoch ms */
  at: number;
  actual?: number;
  forecast?: number;
  previous?: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const LINE = /^\s*([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})(?:\s*\([^)]*\))?[\s\t]+(\d{1,2}):(\d{2})(?:[ \t](.*))?$/;

/** "-3.060M" -> -3.06 (million barrels), "-6234K" -> -6.234, "80B" -> 80 (Bcf), "1.2" -> 1.2; blanks, dashes and anything else -> undefined. */
export function parseMillions(token: string | undefined): number | undefined {
  const m = /^\s*([+\-−]?\d[\d,]*(?:\.\d+)?)\s*([MKBmkb]?)\s*$/.exec((token ?? "").replace(/ /g, " "));
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, "").replace("−", "-"));
  return Number.isFinite(n) ? (m[2].toUpperCase() === "K" ? n / 1000 : n) : undefined;
}

/** A wall-clock time in `tz` as epoch ms. Only UTC (set the browser's zone to UTC when copying) and New York are supported. */
function wallTime(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  if (tz === "UTC") return Date.UTC(y, mo, d, h, mi);
  if (tz === "America/New_York") return zonedTime(tz, y, mo, d, h, mi);
  throw new Error(`unsupported time zone ${tz}`);
}

/**
 * Lines of copied text to occurrences, oldest first. Lines that are not a release row (headings, "Show more", adverts) are skipped. With three cells they
 * are actual, forecast, previous; with tabs a blank cell is kept in place; with two cells (spaces only) a future release is forecast and previous, a past
 * one actual and previous; with one cell it is the actual of a past release. `now` decides future from past.
 */
export function parseInvestingPaste(text: string, tz = "UTC", now = Date.now()): PastedOccurrence[] {
  const out = new Map<number, PastedOccurrence>();
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) continue;
    const at = wallTime(tz, Number(m[3]), month, Number(m[2]), Number(m[4]), Number(m[5]));
    const rest = m[6] ?? "";
    const cells = rest.includes("\t") ? rest.split("\t") : rest.split(/\s+/).filter((c) => c !== "");
    let actual: number | undefined;
    let forecast: number | undefined;
    let previous: number | undefined;
    if (cells.length >= 3) [actual, forecast, previous] = cells.slice(0, 3).map(parseMillions);
    else if (cells.length === 2) {
      if (rest.includes("\t") || at <= now) [actual, previous] = [parseMillions(cells[0]), parseMillions(cells[1])];
      else [forecast, previous] = [parseMillions(cells[0]), parseMillions(cells[1])];
    } else if (cells.length === 1) actual = parseMillions(cells[0]);
    if (actual === undefined && forecast === undefined && previous === undefined) continue;
    out.set(at, { at, actual, forecast, previous });
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
}
