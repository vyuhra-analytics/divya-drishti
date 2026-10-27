// Weekly history behind a release article: the series a report cites, mapped to EIA's Open Data v2 history, and the context worked out from it
// (streaks, the five-year range for the same week, how far the level sits from it, the change the season would normally bring). Pure and tested.
// The report files carry only the latest week (and its year-ago and 4-week figures), so everything about trend comes from here.
import type { EiaPoint } from "./eia";

export interface HistorySeries {
  /** short name used in the article facts, e.g. `crude` */
  key: string;
  label: string;
  /** the series id our stored report uses (eiaReport.ts), so a current value can be matched to its history */
  seriesId: string;
  /** EIA v2 `seriesid` route */
  route: string;
  /** divide EIA's value by this to get the unit the report uses (stocks: thousand barrels -> million barrels) */
  div: number;
  unit: string;
  report: "WPSR" | "WNGSR";
  /** stocks and storage are levels whose weekly change is a build or a draw; the rest are flows or ratios */
  kind: "stock" | "flow";
}

const S = (key: string, label: string, seriesId: string, route: string, report: HistorySeries["report"], kind: HistorySeries["kind"], unit: string, div = 1): HistorySeries => ({ key, label, seriesId, route, report, kind, unit, div });

/** The series an article can set in context. A route EIA does not serve is skipped by the loader, never guessed. */
export const HISTORY_SERIES: readonly HistorySeries[] = [
  S("crude", "Commercial crude stocks (ex SPR)", "WPSR:T1:COMMERCIAL_EXCLUDING_SPR", "PET.WCESTUS1.W", "WPSR", "stock", "MB", 1000),
  S("spr", "Strategic Petroleum Reserve", "WPSR:T1:STRATEGIC_PETROLEUM_RESERVE_SPR", "PET.WCSSTUS1.W", "WPSR", "stock", "MB", 1000),
  S("crude_total", "Crude stocks including SPR", "WPSR:T1:CRUDE_OIL", "PET.WCRSTUS1.W", "WPSR", "stock", "MB", 1000),
  S("cushing", "Cushing crude stocks", "WPSR:T4:CUSHING", "PET.W_EPC0_SAX_YCUOK_MBBL.W", "WPSR", "stock", "MB", 1000),
  S("gasoline", "Motor gasoline stocks", "WPSR:T1:TOTAL_MOTOR_GASOLINE", "PET.WGTSTUS1.W", "WPSR", "stock", "MB", 1000),
  S("distillate", "Distillate stocks", "WPSR:T1:DISTILLATE_FUEL_OIL", "PET.WDISTUS1.W", "WPSR", "stock", "MB", 1000),
  S("jet", "Jet fuel stocks", "WPSR:T1:KEROSENE_TYPE_JET_FUEL", "PET.WKJSTUS1.W", "WPSR", "stock", "MB", 1000),
  S("production", "Domestic crude production", "WPSR:T1:CRUDE_OIL_SUPPLY:DOMESTIC_PRODUCTION", "PET.WCRFPUS2.W", "WPSR", "flow", "kb/d"),
  S("imports", "Crude imports", "WPSR:T1:CRUDE_OIL_SUPPLY:IMPORTS", "PET.WCRIMUS2.W", "WPSR", "flow", "kb/d"),
  S("exports", "Crude exports", "WPSR:T1:CRUDE_OIL_SUPPLY:EXPORTS", "PET.WCREXUS2.W", "WPSR", "flow", "kb/d"),
  S("runs", "Refinery crude inputs", "WPSR:T2:REFINER_INPUTS_AND_UTILIZATION:CRUDE_OIL_INPUTS", "PET.WCRRIUS2.W", "WPSR", "flow", "kb/d"),
  S("utilisation", "Refinery utilisation", "WPSR:T2:REFINER_INPUTS_AND_UTILIZATION:PERCENT_UTILIZATION", "PET.WPULEUS3.W", "WPSR", "flow", "%"),
  S("gasoline_demand", "Gasoline product supplied", "WPSR:T1:PRODUCTS_SUPPLIED:FINISHED_MOTOR_GASOLINE", "PET.WGFUPUS2.W", "WPSR", "flow", "kb/d"),
  S("distillate_demand", "Distillate product supplied", "WPSR:T1:PRODUCTS_SUPPLIED:DISTILLATE_FUEL_OIL", "PET.WDIUPUS2.W", "WPSR", "flow", "kb/d"),
  S("jet_demand", "Jet fuel product supplied", "WPSR:T1:PRODUCTS_SUPPLIED:KEROSENE_TYPE_JET_FUEL", "PET.WKJUPUS2.W", "WPSR", "flow", "kb/d"),
  S("gas_total", "Lower 48 working gas in storage", "WNGSR:TOTAL", "NG.NW2_EPG0_SWO_R48_BCF.W", "WNGSR", "stock", "Bcf"),
  S("gas_east", "East region storage", "WNGSR:EAST", "NG.NW2_EPG0_SWO_R31_BCF.W", "WNGSR", "stock", "Bcf"),
  S("gas_midwest", "Midwest region storage", "WNGSR:MIDWEST", "NG.NW2_EPG0_SWO_R32_BCF.W", "WNGSR", "stock", "Bcf"),
  S("gas_south_central", "South Central region storage", "WNGSR:SOUTH_CENTRAL", "NG.NW2_EPG0_SWO_R33_BCF.W", "WNGSR", "stock", "Bcf"),
  S("gas_mountain", "Mountain region storage", "WNGSR:MOUNTAIN", "NG.NW2_EPG0_SWO_R34_BCF.W", "WNGSR", "stock", "Bcf"),
  S("gas_pacific", "Pacific region storage", "WNGSR:PACIFIC", "NG.NW2_EPG0_SWO_R35_BCF.W", "WNGSR", "stock", "Bcf"),
  S("gas_salt", "Salt cavern storage", "WNGSR:SALT", "NG.NW2_EPG0_SSO_R33_BCF.W", "WNGSR", "stock", "Bcf"),
];

/** The id EIA uses in its own data (`WCESTUS1` from `PET.WCESTUS1.W`), which is how the history table is keyed. */
export const eiaIdOf = (route: string) => route.split(".")[1] ?? route;

export interface SeriesContext {
  /** points used (weeks of history up to the week asked about) */
  weeks: number;
  /** the week the latest point is for, YYYY-MM-DD: older than asked means EIA's history has not caught up with the report yet */
  period: string;
  level: number;
  /** on the previous week */
  change?: number;
  /** on four and eight weeks earlier */
  change4w?: number;
  change8w?: number;
  /** how many weeks in a row the level has moved the same way as it did this week; direction is `draw`, `build` or `flat` */
  streak?: { direction: "draw" | "build" | "flat"; weeks: number };
  yearAgo?: number;
  vsYearAgo?: number;
  /** the same week in each of the five previous years */
  fiveYear?: { avg: number; min: number; max: number; years: number; vsAvg: number; vsAvgPct?: number; /** 0 = at the low of the range, 1 = at the high */ position?: number };
  /** the change the season usually brings: the average change of this same week over the previous five years */
  seasonalChange?: { avg: number; years: number };
  /** weeks since the level was this low (or this high); the whole history when it is the extreme of it */
  lowestInWeeks?: number;
  highestInWeeks?: number;
}

const DAY = 86_400_000;
const at = (p: string) => Date.parse(`${p}T00:00:00Z`);
const near = (points: readonly EiaPoint[], target: number, tol = 4): { p: EiaPoint; i: number } | undefined => {
  let best: { p: EiaPoint; i: number } | undefined;
  points.forEach((p, i) => {
    const d = Math.abs(at(p.period) - target);
    if (d <= tol * DAY && (!best || d < Math.abs(at(best.p.period) - target))) best = { p, i };
  });
  return best;
};
const round = (v: number, d = 3) => Number(v.toFixed(d));

/**
 * `points` is the history of one series in the report's unit, oldest first. Only points up to `weekEnding` are used, so a context built for an
 * older release never sees a later week. Returns undefined when there is nothing at or before that week.
 */
export function seriesContext(points: readonly EiaPoint[], weekEnding: string): SeriesContext | undefined {
  const upto = points.filter((p) => p.period <= weekEnding);
  const latest = upto[upto.length - 1];
  if (!latest) return undefined;
  const n = upto.length;
  const t = at(latest.period);
  const ctx: SeriesContext = { weeks: n, period: latest.period, level: latest.value };
  const back = (k: number) => (n - 1 - k >= 0 ? upto[n - 1 - k].value : undefined);
  const prev = back(1);
  if (prev !== undefined) ctx.change = round(latest.value - prev);
  const b4 = back(4);
  const b8 = back(8);
  if (b4 !== undefined) ctx.change4w = round(latest.value - b4);
  if (b8 !== undefined) ctx.change8w = round(latest.value - b8);

  if (ctx.change !== undefined) {
    const dir = ctx.change > 0 ? "build" : ctx.change < 0 ? "draw" : "flat";
    let weeks = 1;
    for (let i = n - 2; i >= 1; i--) {
      const d = upto[i].value - upto[i - 1].value;
      if ((dir === "build" && d > 0) || (dir === "draw" && d < 0) || (dir === "flat" && d === 0)) weeks++;
      else break;
    }
    ctx.streak = { direction: dir, weeks };
  }

  const year = near(upto, t - 364 * DAY);
  if (year) {
    ctx.yearAgo = year.p.value;
    ctx.vsYearAgo = round(latest.value - year.p.value);
  }
  const same = [1, 2, 3, 4, 5].map((y) => near(upto, t - y * 364 * DAY)).filter((x): x is { p: EiaPoint; i: number } => !!x);
  if (same.length >= 3) {
    const vals = same.map((s) => s.p.value);
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    ctx.fiveYear = {
      avg: round(avg),
      min: round(min),
      max: round(max),
      years: vals.length,
      vsAvg: round(latest.value - avg),
      vsAvgPct: avg !== 0 ? round(((latest.value - avg) / Math.abs(avg)) * 100, 1) : undefined,
      position: max > min ? round((latest.value - min) / (max - min), 2) : undefined,
    };
    const changes = same.flatMap((s) => (s.i > 0 ? [s.p.value - upto[s.i - 1].value] : []));
    if (changes.length >= 3) ctx.seasonalChange = { avg: round(changes.reduce((s, v) => s + v, 0) / changes.length), years: changes.length };
  }

  const lowest = (() => {
    for (let i = n - 2; i >= 0; i--) if (upto[i].value < latest.value) return n - 1 - i;
    return n; // lower than anything in the history
  })();
  const highest = (() => {
    for (let i = n - 2; i >= 0; i--) if (upto[i].value > latest.value) return n - 1 - i;
    return n;
  })();
  ctx.lowestInWeeks = lowest;
  ctx.highestInWeeks = highest;
  return ctx;
}
