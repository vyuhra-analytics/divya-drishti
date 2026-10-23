// The whole official EIA weekly reports as rows: the nine petroleum tables (WPSR, ir.eia.gov/wpsr/table1.csv to table9.csv) and the natural gas
// storage file (WNGSR, ir.eia.gov/ngs/wngsr.csv). Every row keeps this week, last week, the change, the year ago and, where the file has them, the
// 4-week and 5-year averages, so an analysis never needs another source for them. Pure: the API fetches the text, this turns it into rows.
import { csvCells } from "./actuals";
import { zonedTime } from "./eventSeries";

export type EiaReportCode = "WPSR" | "WNGSR";

export interface EiaReportRow {
  /** `WPSR:T4:CRUDE_OIL:...`, `WNGSR:SOUTH_CENTRAL`: the report, the table, the section and the row, stable while EIA keeps its layout */
  seriesId: string;
  report: EiaReportCode;
  /** "T1" to "T9" for the petroleum tables, "" for gas */
  table: string;
  /** the section the row sits in ("Refiner Inputs and Utilization"), "" when the table has none */
  group: string;
  /** the row a regional (PADD) row belongs to ("Crude Oil Inputs"), "" for a top row */
  parent: string;
  label: string;
  unit: string;
  /** position in the file, so a table can be drawn in EIA's own order */
  seq: number;
  /** the week the report covers, UTC midnight */
  periodEnd: number;
  value: number;
  prior?: number;
  change?: number;
  yearAgo?: number;
  yearAgoPct?: number;
  /** the 4-week average and the same average a year ago (petroleum tables 2, 3, 7, 8 and 9) */
  avg4?: number;
  avg4YearAgo?: number;
  /** the 5-year average and the percent difference from it (gas only) */
  fiveYear?: number;
  fiveYearPct?: number;
  /** the figure the market quotes: commercial crude stocks excluding SPR; Lower 48 total gas storage */
  headline: boolean;
}

export interface EiaReport {
  report: EiaReportCode;
  /** the week the report covers */
  periodEnd: number;
  /** the exact official release time, when the file states it (gas does) */
  releasedAt?: number;
  rows: EiaReportRow[];
}

const num = (s: string | undefined) => {
  const t = (s ?? "").replace(/,/g, "").trim();
  const n = Number(t);
  return t !== "" && Number.isFinite(n) ? n : undefined;
};

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

const slug = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** "10/16/26" → UTC midnight */
function mdy(s: string): number | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s.trim());
  if (!m) return undefined;
  return Date.UTC(Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

const isDate = (s: string) => mdy(s) !== undefined;
const isChild = (label: string) => /\(PADD|^PADDs? /i.test(label);

/** The units of each petroleum table's blocks: stocks in million barrels, flows in thousand barrels a day. */
const WPSR_UNITS: Record<number, string[]> = {
  1: ["million barrels", "kb/d"],
  2: ["kb/d"],
  3: ["kb/d"],
  4: ["million barrels"],
  5: ["million barrels"],
  6: ["million barrels"],
  7: ["kb/d"],
  8: ["kb/d"],
  9: ["kb/d"],
};

const cleanLabel = (s: string) => s.replace(/^\s*\(\d+\)\s*/, "").replace(/\s+/g, " ").trim();

/** One petroleum table (a file can hold several blocks, each starting with its own `STUB_1` header line). */
export function parseWpsrTable(table: number, csv: string): EiaReportRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  const out: EiaReportRow[] = [];
  const used = new Map<string, number>();
  let block = -1;
  let cols: { label: number[]; cur: number; prior?: number; diff: number; yearAgo?: number; yearPct?: number; avg4?: number; avg4Ya?: number; periodEnd: number } | undefined;
  let parent = "";
  let parentUnit: string | undefined;
  for (const line of lines) {
    const c = csvCells(line);
    if (c[0] === "STUB_1") {
      block++;
      parent = "";
      parentUnit = undefined;
      const dates = c.map((h, i) => (isDate(h) ? i : -1)).filter((i) => i >= 0);
      const diff = c.findIndex((h) => /^difference$/i.test(h));
      const yearAgo = diff >= 0 ? dates.find((i) => i > diff) : dates[2];
      const avg4 = dates.find((i) => i > dates[0] && c[i] === c[dates[0]]);
      const periodEnd = dates.length ? mdy(c[dates[0]]) : undefined;
      cols =
        periodEnd === undefined
          ? undefined
          : {
              label: c.map((h, i) => (h.startsWith("STUB_") ? i : -1)).filter((i) => i >= 0),
              cur: dates[0],
              prior: dates[1],
              diff,
              yearAgo,
              yearPct: yearAgo !== undefined ? [yearAgo + 1, yearAgo + 2].find((i) => /percent/i.test(c[i] ?? "")) : undefined, // the file has put it right after the date or after a Difference column
              avg4,
              avg4Ya: avg4 !== undefined ? dates.find((i) => i > avg4) : undefined,
              periodEnd,
            };
      continue;
    }
    if (!cols) continue;
    const value = num(c[cols.cur]);
    const label = cleanLabel(c[cols.label[cols.label.length - 1]] ?? "");
    if (value === undefined || !label) continue;
    const group = cols.label.length > 1 ? cleanLabel(c[cols.label[0]] ?? "") : "";
    const child = isChild(label);
    if (!child && label !== "Cushing") {
      // Cushing sits between the PADD rows of the crude stocks table but is not their parent
      parent = label;
      parentUnit = /utilization/i.test(label) ? "%" : undefined;
    }
    const base = [`WPSR:T${table}`, slug(group), child ? slug(parent) : "", slug(label)].filter(Boolean).join(":");
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const prior = cols.prior !== undefined ? num(c[cols.prior]) : undefined;
    const diff = cols.diff >= 0 ? num(c[cols.diff]) : prior !== undefined ? round6(value - prior) : undefined;
    out.push({
      seriesId: n === 1 ? base : `${base}:${n}`,
      report: "WPSR",
      table: `T${table}`,
      group,
      parent: child ? parent : "",
      label,
      unit: parentUnit ?? WPSR_UNITS[table]?.[Math.min(block, (WPSR_UNITS[table]?.length ?? 1) - 1)] ?? "",
      seq: out.length,
      periodEnd: cols.periodEnd,
      value,
      prior,
      change: diff,
      yearAgo: cols.yearAgo !== undefined ? num(c[cols.yearAgo]) : undefined,
      yearAgoPct: cols.yearPct !== undefined ? num(c[cols.yearPct]) : undefined,
      avg4: cols.avg4 !== undefined ? num(c[cols.avg4]) : undefined,
      avg4YearAgo: cols.avg4Ya !== undefined ? num(c[cols.avg4Ya]) : undefined,
      headline: table === 1 && block === 0 && label === "Commercial (Excluding SPR)",
    });
  }
  return out;
}

/** All nine petroleum tables (keyed 1 to 9) as one report; a missing or unreadable table is left out, and the week must agree across the tables. */
export function parseWpsrReport(files: Record<number, string | undefined>): EiaReport | undefined {
  const rows: EiaReportRow[] = [];
  for (let t = 1; t <= 9; t++) {
    const text = files[t];
    if (text) rows.push(...parseWpsrTable(t, text));
  }
  const weeks = new Set(rows.map((r) => r.periodEnd));
  if (rows.length === 0 || weeks.size !== 1) return undefined; // tables of two different weeks are a release in progress: never mix them
  return { report: "WPSR", periodEnd: [...weeks][0], rows };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "Released: October 22, 2026 at 10:30 a.m. (eastern time)" → epoch ms */
function releasedAtOf(csv: string): number | undefined {
  const m = /Released:\s*([A-Za-z]+) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2}) ([ap])\.?m\./i.exec(csv);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (!m || month < 0) return undefined;
  const hour = (Number(m[4]) % 12) + (m[6].toLowerCase() === "p" ? 12 : 0);
  return zonedTime("America/New_York", Number(m[3]), month, Number(m[2]), hour, Number(m[5]));
}

/** The natural gas storage file: the five regions with Salt and Nonsalt, and the Lower 48 total, with year-ago and 5-year comparisons. */
export function parseWngsrReport(csv: string): EiaReport | undefined {
  const we = /Week Ending ([A-Za-z]+ \d{1,2}, \d{4})/.exec(csv);
  const periodEnd = we ? Date.parse(`${we[1]} UTC`) : NaN;
  const rows = csv.split(/\r?\n/).map(csvCells);
  const head = rows.find((c) => c.some((x) => /net change/i.test(x)));
  const dates = rows.find((c) => c.filter((x) => /^\d{2}-[A-Za-z]{3}-\d{2}$/.test(x)).length >= 2);
  if (!Number.isFinite(periodEnd) || !head || !dates) return undefined;
  const at = (cells: string[], re: RegExp) => cells.findIndex((x) => re.test(x));
  const dateIdx = dates.map((x, i) => (/^\d{2}-[A-Za-z]{3}-\d{2}$/.test(x) ? i : -1)).filter((i) => i >= 0);
  const stocks = head.map((x, i) => (/^stocks/i.test(x) ? i : -1)).filter((i) => i >= 0); // year ago, then 5-year average
  const pct = head.map((x, i) => (/% change/i.test(x) ? i : -1)).filter((i) => i >= 0);
  const changeAt = at(head, /net change/i);
  const regions = new Set(["East", "Midwest", "Mountain", "Pacific", "South Central", "Salt", "Nonsalt", "Total"]);
  const out: EiaReportRow[] = [];
  for (const c of rows) {
    const label = (c[0] ?? "").trim();
    const value = num(c[dateIdx[0]]);
    if (!regions.has(label) || value === undefined) continue;
    out.push({
      seriesId: `WNGSR:${slug(label)}`,
      report: "WNGSR",
      table: "",
      group: "",
      parent: label === "Salt" || label === "Nonsalt" ? "South Central" : "",
      label,
      unit: "Bcf",
      seq: out.length,
      periodEnd,
      value,
      prior: num(c[dateIdx[1]]),
      change: num(c[changeAt]),
      yearAgo: stocks[0] !== undefined ? num(c[stocks[0]]) : undefined,
      yearAgoPct: pct[0] !== undefined ? num(c[pct[0]]) : undefined,
      fiveYear: stocks[1] !== undefined ? num(c[stocks[1]]) : undefined,
      fiveYearPct: pct[1] !== undefined ? num(c[pct[1]]) : undefined,
      headline: label === "Total",
    });
  }
  return out.length ? { report: "WNGSR", periodEnd, releasedAt: releasedAtOf(csv), rows: out } : undefined;
}
