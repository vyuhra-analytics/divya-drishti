// EIA Open Data API v2 (api.eia.gov, free key): weekly US stocks, refinery utilisation, product supplied and daily spot prices.
// Pure parsing and comparison against last week, last year and the five-year average for the same week. Tested.

/** The series we show: EIA series id → label, route ("PET.<id>.W" style), unit and frequency. */
export const EIA_SERIES = [
  { id: "WCESTUS1", label: "Crude stocks (ex SPR)", route: "PET.WCESTUS1.W", unit: "kb", freq: "weekly", group: "Stocks" },
  { id: "W_EPC0_SAX_YCUOK_MBBL", label: "Cushing stocks", route: "PET.W_EPC0_SAX_YCUOK_MBBL.W", unit: "kb", freq: "weekly", group: "Stocks" },
  { id: "WGTSTUS1", label: "Gasoline stocks", route: "PET.WGTSTUS1.W", unit: "kb", freq: "weekly", group: "Stocks" },
  { id: "WDISTUS1", label: "Distillate stocks", route: "PET.WDISTUS1.W", unit: "kb", freq: "weekly", group: "Stocks" },
  { id: "WCSSTUS1", label: "SPR stocks", route: "PET.WCSSTUS1.W", unit: "kb", freq: "weekly", group: "Stocks" },
  { id: "WPULEUS3", label: "Refinery utilisation", route: "PET.WPULEUS3.W", unit: "%", freq: "weekly", group: "Demand" },
  { id: "WRPUPUS2", label: "Product supplied", route: "PET.WRPUPUS2.W", unit: "kb/d", freq: "weekly", group: "Demand" },
  { id: "RWTC", label: "WTI spot", route: "PET.RWTC.D", unit: "$/bbl", freq: "daily", group: "Spot" },
  { id: "RBRTE", label: "Brent spot", route: "PET.RBRTE.D", unit: "$/bbl", freq: "daily", group: "Spot" },
  { id: "RNGWHHD", label: "Henry Hub spot", route: "NG.RNGWHHD.D", unit: "$/MMBtu", freq: "daily", group: "Spot" },
] as const;
export type EiaSeriesId = (typeof EIA_SERIES)[number]["id"];

export interface EiaPoint {
  /** YYYY-MM-DD */
  period: string;
  value: number;
}

/** v2 response (`{response:{data:[{period, value}]}}`, values often strings) → points, oldest first. Rows without a number are skipped. */
export function parseEia(json: any): EiaPoint[] {
  const out: EiaPoint[] = [];
  for (const r of json?.response?.data ?? []) {
    const value = r?.value === null || r?.value === "" ? NaN : Number(r?.value);
    if (typeof r?.period === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.period) && Number.isFinite(value)) out.push({ period: r.period, value });
  }
  return out.sort((a, b) => a.period.localeCompare(b.period));
}

const DAY = 86_400_000;
const at = (p: string) => Date.parse(`${p}T00:00:00Z`);

/** The point closest to `target` (epoch ms) within `tol` days, or undefined. */
function near(points: EiaPoint[], target: number, tol: number): EiaPoint | undefined {
  let best: EiaPoint | undefined;
  for (const p of points) if (Math.abs(at(p.period) - target) <= tol * DAY && (!best || Math.abs(at(p.period) - target) < Math.abs(at(best.period) - target))) best = p;
  return best;
}

export interface EiaSummary {
  id: string;
  latest?: EiaPoint;
  /** change on the previous reading (previous week, or previous trading day) */
  change?: number;
  /** change on the reading one year earlier */
  yoyChange?: number;
  /** latest minus the average of the same week in each of the five previous years (needs 3 of them) */
  vsFiveYear?: number;
  /** the five-year average itself */
  fiveYearAvg?: number;
}

/** Latest reading with its change on the last one, on last year, and against the five-year average for the same time of year. */
export function summarizeEia(id: string, points: EiaPoint[]): EiaSummary {
  const latest = points[points.length - 1];
  if (!latest) return { id };
  const t = at(latest.period);
  const prev = points[points.length - 2];
  const yearAgo = near(points, t - 364 * DAY, 4);
  const same = [1, 2, 3, 4, 5].map((y) => near(points, t - y * 364 * DAY, 4)).filter((p): p is EiaPoint => !!p); // 52-week steps keep the weekday
  const avg = same.length >= 3 ? same.reduce((s, p) => s + p.value, 0) / same.length : undefined;
  return {
    id,
    latest,
    change: prev ? latest.value - prev.value : undefined,
    yoyChange: yearAgo ? latest.value - yearAgo.value : undefined,
    fiveYearAvg: avg,
    vsFiveYear: avg === undefined ? undefined : latest.value - avg,
  };
}
