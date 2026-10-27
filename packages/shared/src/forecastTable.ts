// The forecasts of the weekly EIA and API releases laid against what came out: one row per EIA release with the forecast, the actual and the surprise
// (the week's change minus the forecast) for crude, gasoline and distillates, and the API's report the day before; and, for each series, how the
// forecasts have done (the average miss and its sign) and how many weeks the app's report-day rule would have allowed a side. Pure and tested.
// Forecasts are Investing.com's consensus (third-party). Actuals are the PUBLISHED EIA figures where a report is stored for the week, else the
// figure on the same page, and the row says which.

export type EiaKey = "crude" | "gasoline" | "distillates";

export interface ForecastRowIn {
  series: "eia_crude" | "eia_gasoline" | "eia_distillates" | "api_crude" | "eia_gas";
  /** the scheduled release, epoch ms */
  releaseAt: number;
  forecast?: number;
  /** the figure the page itself shows for the release, in million barrels */
  actual?: number;
}

export interface PublishedChange {
  /** the report's official release time, epoch ms */
  at: number;
  crude?: number;
  gasoline?: number;
  distillates?: number;
}

export interface Cell {
  forecast?: number;
  actual?: number;
  /** actual - forecast: negative = a bigger draw (or smaller build) than the forecast */
  surprise?: number;
  /** where `actual` came from */
  actualFrom?: "published" | "investing";
}

export interface ForecastRelease {
  releaseAt: number;
  /** a release that has not happened yet: the forecast only */
  upcoming: boolean;
  crude: Cell;
  gasoline: Cell;
  distillates: Cell;
  /** the API's report the day before, with its forecast; its actual is the page's own (the API's data is not published free) */
  api: Cell;
}

export interface SeriesStats {
  /** releases with both a forecast and an actual */
  n: number;
  /** average surprise: the forecasts' bias (negative = the market drew more than forecast on average) */
  bias: number;
  /** average size of the miss */
  meanAbs: number;
}

export interface RuleStats {
  threshold: number;
  /** releases whose surprise reached the threshold, and which side the app's rule allows: a draw below forecast = long, above = short */
  reached: number;
  long: number;
  short: number;
  of: number;
}

export interface ForecastTable {
  releases: ForecastRelease[];
  stats: Record<EiaKey | "api", SeriesStats | undefined>;
  /** crude only: the report-day rule */
  rule: RuleStats | undefined;
}

/** the release day of a forecast and of a report agree when they are this close (a holiday moves a release by hours, not days) */
const MATCH_MS = 20 * 3600_000;
const API_BEFORE = { from: 48 * 3600_000, to: 6 * 3600_000 };
const r2 = (v: number) => Number(v.toFixed(2));

const SERIES: Record<EiaKey, ForecastRowIn["series"]> = { crude: "eia_crude", gasoline: "eia_gasoline", distillates: "eia_distillates" };

function cell(forecast: number | undefined, published: number | undefined, page: number | undefined): Cell {
  const actual = published ?? page;
  return {
    forecast,
    actual: actual === undefined ? undefined : r2(actual),
    surprise: forecast !== undefined && actual !== undefined ? r2(actual - forecast) : undefined,
    actualFrom: published !== undefined ? "published" : page !== undefined ? "investing" : undefined,
  };
}

function stats(cells: Cell[]): SeriesStats | undefined {
  const s = cells.flatMap((c) => (c.surprise === undefined ? [] : [c.surprise]));
  if (!s.length) return undefined;
  return { n: s.length, bias: r2(s.reduce((a, b) => a + b, 0) / s.length), meanAbs: r2(s.reduce((a, b) => a + Math.abs(b), 0) / s.length) };
}

/**
 * The newest `weeks` EIA releases (crude's page defines them) plus the next one when it is on the page, newest first. The three EIA series are matched
 * to a release by time, the API's report is the one 6 to 48 hours before it.
 */
export function buildForecastTable(input: { rows: readonly ForecastRowIn[]; published: readonly PublishedChange[]; now: number; weeks: number; threshold?: number }): ForecastTable {
  const threshold = input.threshold ?? 3;
  const bySeries = (s: ForecastRowIn["series"]) => input.rows.filter((r) => r.series === s);
  const near = (s: ForecastRowIn["series"], at: number) => bySeries(s).filter((r) => Math.abs(r.releaseAt - at) <= MATCH_MS).sort((a, b) => Math.abs(a.releaseAt - at) - Math.abs(b.releaseAt - at))[0];
  const pub = (at: number) => input.published.filter((p) => Math.abs(p.at - at) <= MATCH_MS).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];

  const all = [...new Set(bySeries("eia_crude").map((r) => r.releaseAt))].sort((a, b) => b - a);
  const past = all.filter((t) => t <= input.now).slice(0, input.weeks);
  const next = all.filter((t) => t > input.now).sort((a, b) => a - b)[0];
  const times = [...(next === undefined ? [] : [next]), ...past];

  const releases: ForecastRelease[] = times.map((at) => {
    const p = pub(at);
    const upcoming = at > input.now;
    const eia = (k: EiaKey) => {
      const row = near(SERIES[k], at);
      return cell(row?.forecast, upcoming ? undefined : p?.[k], upcoming ? undefined : row?.actual);
    };
    const apiRow = bySeries("api_crude").filter((r) => at - r.releaseAt >= API_BEFORE.to && at - r.releaseAt <= API_BEFORE.from).sort((a, b) => b.releaseAt - a.releaseAt)[0];
    return { releaseAt: at, upcoming, crude: eia("crude"), gasoline: eia("gasoline"), distillates: eia("distillates"), api: cell(apiRow?.forecast, undefined, upcoming ? undefined : apiRow?.actual) };
  });

  const done = releases.filter((r) => !r.upcoming);
  const crudeSurprises = done.flatMap((r) => (r.crude.surprise === undefined ? [] : [r.crude.surprise]));
  return {
    releases,
    stats: { crude: stats(done.map((r) => r.crude)), gasoline: stats(done.map((r) => r.gasoline)), distillates: stats(done.map((r) => r.distillates)), api: stats(done.map((r) => r.api)) },
    rule: crudeSurprises.length
      ? { threshold, of: crudeSurprises.length, reached: crudeSurprises.filter((s) => Math.abs(s) >= threshold).length, long: crudeSurprises.filter((s) => s <= -threshold).length, short: crudeSurprises.filter((s) => s >= threshold).length }
      : undefined,
  };
}

export interface GasForecastTable {
  releases: { releaseAt: number; upcoming: boolean; storage: Cell }[];
  stats: SeriesStats | undefined;
  /** the report-day rule for gas: a build below forecast by the threshold (Bcf) = long, above = short */
  rule: RuleStats | undefined;
}

/**
 * Natural gas storage (WNGSR): the same layout for the one series, in Bcf. EIA keeps no archive of past gas reports, so the actual is the figure on
 * Investing.com's page (marked as such). The newest `weeks` releases plus the next one, newest first.
 */
export function buildGasForecastTable(input: { rows: readonly ForecastRowIn[]; now: number; weeks: number; threshold?: number }): GasForecastTable {
  const threshold = input.threshold ?? 5;
  const gas = input.rows.filter((r) => r.series === "eia_gas");
  const times = [...new Set(gas.map((r) => r.releaseAt))].sort((a, b) => b - a);
  const past = times.filter((t) => t <= input.now).slice(0, input.weeks);
  const next = times.filter((t) => t > input.now).sort((a, b) => a - b)[0];
  const releases = [...(next === undefined ? [] : [next]), ...past].map((at) => {
    const row = gas.find((r) => r.releaseAt === at);
    const upcoming = at > input.now;
    return { releaseAt: at, upcoming, storage: cell(row?.forecast, undefined, upcoming ? undefined : row?.actual) };
  });
  const done = releases.filter((r) => !r.upcoming).map((r) => r.storage);
  const s = done.flatMap((c) => (c.surprise === undefined ? [] : [c.surprise]));
  return {
    releases,
    stats: stats(done),
    rule: s.length ? { threshold, of: s.length, reached: s.filter((x) => Math.abs(x) >= threshold).length, long: s.filter((x) => x <= -threshold).length, short: s.filter((x) => x >= threshold).length } : undefined,
  };
}
