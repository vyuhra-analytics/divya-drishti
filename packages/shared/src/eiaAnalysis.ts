// What a trader reads in an EIA report, worked out from the report's own rows. Every line is one rule over cited cells (`cites` are series ids), with no
// model and no outside data, so it can be checked against the tables. It states what happened and what the strategy's rule allows; it gives no advice.
import type { EiaReport, EiaReportRow } from "./eiaReport";

export type Severity = "info" | "note" | "flag";

export interface AnalysisLine {
  id: string;
  severity: Severity;
  text: string;
  /** the series ids the sentence is built from */
  cites: string[];
}

export interface AnalysisSection {
  id: string;
  title: string;
  lines: AnalysisLine[];
}

export interface HeadlineBlock {
  label: string;
  unit: string;
  /** the stock level after the report and the week's change */
  level: number;
  change: number;
  yearAgoPct?: number;
  /** the forecast of the change and the surprise against it; undefined until a forecast is known */
  forecast?: number;
  surprise?: number;
  threshold: number;
  passes: boolean;
  /** the side the strategy's surprise rule allows: a draw (or storage) below forecast by the threshold = long, above = short */
  side: "long" | "short" | "none";
  sideText: string;
}

export interface ReportAnalysis {
  report: "WPSR" | "WNGSR";
  weekEnding: string;
  headline: HeadlineBlock;
  sections: AnalysisSection[];
}

export interface AnalysisOptions {
  /** forecast of the headline change (million barrels, or Bcf for gas) */
  forecast?: number;
  /** the surprise that sets a side; defaults to the strategy's 3 million barrels / 5.0 Bcf */
  threshold?: number;
}

/** The thresholds the lines use, in one place. */
export const RULES = {
  crudeSurprise: 3.0,
  gasSurprise: 5.0,
  /** a balancing item this large (kb/d) means the headline may be revised and the story is partly guesswork */
  bigAdjustmentKbd: 300,
  /** a Cushing move this large (million barrels) is worth a line of its own */
  cushingMove: 2.0,
  /** utilisation (percent) at or above which refiners are running near the limit, and at or below which something is down */
  utilHigh: 95,
  utilLow: 88,
  /** days of supply this many percent away from a year ago is flagged */
  daysOfSupplyPct: 10,
};

const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "-" : "");
const fmt = (n: number, dp = 1) => Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const signed = (n: number, dp = 1) => `${sign(Math.round(n * 10 ** dp) / 10 ** dp)}${fmt(n, dp)}`;
const pct = (a: number, b: number) => (b ? ((a - b) / b) * 100 : undefined);
const dir = (n: number, up: string, down: string) => (n > 0 ? up : n < 0 ? down : "unchanged");

type Index = Map<string, EiaReportRow>;
const index = (r: EiaReport): Index => new Map(r.rows.map((x) => [x.seriesId, x]));

function headlineBlock(label: string, unit: string, row: EiaReportRow, threshold: number, forecast: number | undefined, drawIsLong: boolean): HeadlineBlock {
  const change = row.change ?? 0;
  const surprise = forecast === undefined ? undefined : Math.round((change - forecast) * 1000) / 1000;
  const passes = surprise !== undefined && Math.abs(surprise) >= threshold;
  const side = !passes ? "none" : (surprise! < 0) === drawIsLong ? "long" : "short";
  const sideText =
    forecast === undefined
      ? "No forecast yet: type one in or wait for Forex Factory"
      : !passes
        ? `Surprise ${signed(surprise!)} ${unit} is under the ${fmt(threshold)} threshold: the number sets no side, a range break alone can`
        : side === "long"
          ? `Surprise ${signed(surprise!)} ${unit} (below forecast) passes ${fmt(threshold)}: the rule allows long (calls) only`
          : `Surprise ${signed(surprise!)} ${unit} (above forecast) passes ${fmt(threshold)}: the rule allows short (puts) only`;
  return { label, unit, level: row.value, change, yearAgoPct: row.yearAgoPct ?? (row.yearAgo ? pct(row.value, row.yearAgo) : undefined), forecast, surprise, threshold, passes, side, sideText };
}

type Add = (sectionId: string, title: string, line: AnalysisLine) => void;

function sections(): { add: Add; out: AnalysisSection[] } {
  const out: AnalysisSection[] = [];
  return {
    out,
    add(id, title, line) {
      let s = out.find((x) => x.id === id);
      if (!s) out.push((s = { id, title, lines: [] }));
      s.lines.push(line);
    },
  };
}

/** Days of supply: stocks (million barrels) over demand (thousand barrels a day). */
const days = (stockMb: number, demandKbd: number) => (demandKbd > 0 ? (stockMb * 1000) / demandKbd : undefined);

export function analyzeWpsr(report: EiaReport, opts: AnalysisOptions = {}): ReportAnalysis | undefined {
  const ix = index(report);
  const get = (id: string) => ix.get(id);
  const commercial = get("WPSR:T1:COMMERCIAL_EXCLUDING_SPR");
  if (!commercial) return undefined;
  const threshold = opts.threshold ?? RULES.crudeSurprise;
  const headline = headlineBlock("Commercial crude stocks (excluding SPR)", "MB", commercial, threshold, opts.forecast, true);
  const { add, out } = sections();
  const C = "WPSR:T1:COMMERCIAL_EXCLUDING_SPR";

  // --- crude stocks and what moved them
  const yoy = commercial.yearAgoPct ?? pct(commercial.value, commercial.yearAgo ?? 0);
  add("crude", "Crude stocks", {
    id: "crude-level",
    severity: "info",
    text: `Commercial crude ${dir(commercial.change ?? 0, "built", "drew")} ${fmt(commercial.change ?? 0, 3)} MB to ${fmt(commercial.value, 1)} MB${yoy !== undefined ? `, ${fmt(yoy, 1)}% ${yoy < 0 ? "below" : "above"} a year ago` : ""}.`,
    cites: [C],
  });
  const total = get("WPSR:T1:CRUDE_OIL");
  const spr = get("WPSR:T1:STRATEGIC_PETROLEUM_RESERVE_SPR");
  if (total && spr && spr.change !== undefined && Math.abs(spr.change) >= 0.1)
    add("crude", "Crude stocks", { id: "spr", severity: "note", text: `The SPR ${dir(spr.change, "rose", "fell")} ${fmt(spr.change, 1)} MB to ${fmt(spr.value, 1)} MB, so total crude (with SPR) moved ${signed(total.change ?? 0, 1)} MB against ${signed(commercial.change ?? 0, 1)} MB commercial.`, cites: [spr.seriesId, total.seriesId, C] });
  const cushing = get("WPSR:T4:CUSHING");
  if (cushing && cushing.change !== undefined)
    add("crude", "Crude stocks", {
      id: "cushing",
      severity: Math.abs(cushing.change) >= RULES.cushingMove ? "flag" : "info",
      text: `Cushing ${dir(cushing.change, "built", "drew")} ${fmt(cushing.change, 3)} MB to ${fmt(cushing.value, 1)} MB${cushing.yearAgoPct !== undefined ? ` (${signed(cushing.yearAgoPct, 1)}% on a year ago)` : ""}; this is the delivery point of the NYMEX contract.`,
      cites: [cushing.seriesId],
    });
  const gulf = get("WPSR:T4:COMMERCIAL_EXCLUDING_SPR:GULF_COAST_PADD_3");
  const mid = get("WPSR:T4:COMMERCIAL_EXCLUDING_SPR:MIDWEST_PADD_2");
  if (gulf && mid && gulf.change !== undefined && mid.change !== undefined)
    add("crude", "Crude stocks", { id: "regions", severity: "info", text: `By region: Gulf Coast ${signed(gulf.change, 1)} MB, Midwest ${signed(mid.change, 1)} MB${cushing?.change !== undefined ? `, Cushing ${signed(cushing.change, 1)} MB` : ""}.`, cites: [gulf.seriesId, mid.seriesId, ...(cushing ? [cushing.seriesId] : [])] });

  // --- the drivers: what each flow did to commercial stocks this week (kb/d)
  const prod = get("WPSR:T1:CRUDE_OIL_SUPPLY:DOMESTIC_PRODUCTION");
  const imp = get("WPSR:T1:CRUDE_OIL_SUPPLY:COMMERCIAL_CRUDE_OIL");
  const exp = get("WPSR:T1:CRUDE_OIL_SUPPLY:EXPORTS");
  const runs = get("WPSR:T1:CRUDE_OIL_SUPPLY:CRUDE_OIL_INPUT_TO_REFINERIES");
  const adj = get("WPSR:T1:CRUDE_OIL_SUPPLY:ADJUSTMENT");
  const drivers = [
    prod && { name: "domestic production", row: prod, effect: prod.change ?? 0 },
    imp && { name: "commercial imports", row: imp, effect: imp.change ?? 0 },
    exp && { name: "exports", row: exp, effect: -(exp.change ?? 0) },
    runs && { name: "refinery crude runs", row: runs, effect: -(runs.change ?? 0) },
  ].filter(Boolean) as { name: string; row: EiaReportRow; effect: number }[];
  if (drivers.length === 4) {
    const ranked = [...drivers].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
    const part = (d: (typeof drivers)[number]) => `${d.name} ${signed(d.row.change ?? 0, 0)} kb/d (${d.effect < 0 ? "towards a draw" : d.effect > 0 ? "towards a build" : "neutral"})`;
    add("drivers", "What moved it (week on week, kb/d)", {
      id: "drivers",
      severity: "info",
      text: `Biggest changes: ${ranked.slice(0, 3).map(part).join("; ")}.`,
      cites: ranked.slice(0, 3).map((d) => d.row.seriesId),
    });
    if (exp?.change !== undefined && Math.abs(exp.change) >= 500)
      add("drivers", "What moved it (week on week, kb/d)", { id: "exports", severity: "note", text: `Crude exports ${dir(exp.change, "rose", "fell")} ${fmt(exp.change, 0)} kb/d to ${fmt(exp.value, 0)} kb/d (4-week average ${exp.avg4 !== undefined ? fmt(exp.avg4, 0) : "n/a"}); export weeks are volatile and move the headline.`, cites: [exp.seriesId] });
    if (adj?.value !== undefined)
      add("drivers", "What moved it (week on week, kb/d)", {
        id: "adjustment",
        severity: Math.abs(adj.value) >= RULES.bigAdjustmentKbd ? "flag" : "info",
        text: `EIA's balancing adjustment is ${signed(adj.value, 0)} kb/d${Math.abs(adj.value) >= RULES.bigAdjustmentKbd ? ", large: part of the stock change is not explained by measured flows" : ""}.`,
        cites: [adj.seriesId],
      });
  }
  const netImp = get("WPSR:T1:CRUDE_OIL_SUPPLY:NET_IMPORTS_INCLUDING_SPR");
  if (netImp?.change !== undefined)
    add("drivers", "What moved it (week on week, kb/d)", { id: "net-imports", severity: "info", text: `Crude net imports ${fmt(netImp.value, 0)} kb/d, ${signed(netImp.change, 0)} on the week.`, cites: [netImp.seriesId] });

  // --- refining
  const util = get("WPSR:T2:REFINER_INPUTS_AND_UTILIZATION:PERCENT_UTILIZATION");
  if (util)
    add("refining", "Refining", {
      id: "utilisation",
      severity: util.value >= RULES.utilHigh || util.value <= RULES.utilLow ? "flag" : "info",
      text: `Refinery utilisation ${fmt(util.value, 1)}% (${signed(util.change ?? 0, 1)} pt on the week${util.avg4 !== undefined ? `, 4-week average ${fmt(util.avg4, 1)}%` : ""}${util.yearAgo !== undefined ? `, ${fmt(util.yearAgo, 1)}% a year ago` : ""}).`,
      cites: [util.seriesId],
    });
  const gulfUtil = get("WPSR:T2:REFINER_INPUTS_AND_UTILIZATION:PERCENT_UTILIZATION:GULF_COAST_PADD_3");
  if (gulfUtil) add("refining", "Refining", { id: "gulf-util", severity: "info", text: `Gulf Coast utilisation ${fmt(gulfUtil.value, 1)}% (${signed(gulfUtil.change ?? 0, 1)} pt).`, cites: [gulfUtil.seriesId] });

  // --- products: stocks, demand, days of supply
  const products: [string, string, string, string][] = [
    ["Gasoline", "WPSR:T1:TOTAL_MOTOR_GASOLINE", "WPSR:T1:PRODUCTS_SUPPLIED:FINISHED_MOTOR_GASOLINE", "gasoline"],
    ["Distillate", "WPSR:T1:DISTILLATE_FUEL_OIL", "WPSR:T1:PRODUCTS_SUPPLIED:DISTILLATE_FUEL_OIL", "distillate"],
    ["Jet fuel", "WPSR:T1:KEROSENE_TYPE_JET_FUEL", "WPSR:T1:PRODUCTS_SUPPLIED:KEROSENE_TYPE_JET_FUEL", "jet"],
  ];
  for (const [name, stockId, demandId, key] of products) {
    const stock = get(stockId);
    const demand = get(demandId);
    if (!stock) continue;
    const d = demand ? days(stock.value, demand.value) : undefined;
    const dAgo = demand && stock.yearAgo !== undefined && demand.yearAgo !== undefined ? days(stock.yearAgo, demand.yearAgo) : undefined;
    const rel = d !== undefined && dAgo ? pct(d, dAgo) : undefined;
    add("products", "Products", {
      id: `${key}`,
      severity: rel !== undefined && Math.abs(rel) >= RULES.daysOfSupplyPct ? "flag" : "info",
      text: `${name} stocks ${dir(stock.change ?? 0, "built", "drew")} ${fmt(stock.change ?? 0, 2)} MB to ${fmt(stock.value, 1)} MB${demand ? `; demand ${fmt(demand.value, 0)} kb/d (${signed(demand.change ?? 0, 0)} on the week${demand.avg4 !== undefined ? `, 4-week ${fmt(demand.avg4, 0)}` : ""})` : ""}${d !== undefined ? `; ${fmt(d, 1)} days of supply${dAgo ? ` against ${fmt(dAgo, 1)} a year ago` : ""}` : ""}.`,
      cites: [stockId, ...(demand ? [demandId] : [])],
    });
  }
  const demandTotal = get("WPSR:T1:PRODUCTS_SUPPLIED:TOTAL");
  if (demandTotal)
    add("products", "Products", {
      id: "demand",
      severity: "info",
      text: `Total product supplied (implied demand) ${fmt(demandTotal.value, 0)} kb/d, ${signed(demandTotal.change ?? 0, 0)} on the week${demandTotal.avg4 !== undefined ? ` and ${signed(demandTotal.value - demandTotal.avg4, 0)} against the 4-week average` : ""}${demandTotal.yearAgo ? `, ${signed(pct(demandTotal.value, demandTotal.yearAgo) ?? 0, 1)}% on a year ago` : ""}.`,
      cites: [demandTotal.seriesId],
    });

  // --- checks: do the parts agree with the headline
  const gas = get("WPSR:T1:TOTAL_MOTOR_GASOLINE");
  const dist = get("WPSR:T1:DISTILLATE_FUEL_OIL");
  const crudeChange = commercial.change ?? 0;
  if (gas?.change !== undefined && dist?.change !== undefined) {
    const drew = [crudeChange, gas.change, dist.change].filter((c) => c < 0).length;
    add("checks", "Do the parts agree", {
      id: "breadth",
      severity: drew === 3 || drew === 0 ? "note" : "info",
      text: drew === 3 ? "Crude, gasoline and distillate all drew: a broad draw." : drew === 0 ? "Crude, gasoline and distillate all built: a broad build." : `Mixed: crude ${dir(crudeChange, "built", "drew")}, gasoline ${dir(gas.change, "built", "drew")}, distillate ${dir(dist.change, "built", "drew")}.`,
      cites: [C, gas.seriesId, dist.seriesId],
    });
  }
  if (exp?.change !== undefined && runs?.change !== undefined && Math.abs(crudeChange) >= 1) {
    const exportDriven = crudeChange < 0 ? exp.change > 500 : exp.change < -500;
    const runsDriven = crudeChange < 0 ? runs.change > 100 : runs.change < -100;
    add("checks", "Do the parts agree", {
      id: "source",
      severity: "info",
      text: exportDriven
        ? `The ${crudeChange < 0 ? "draw" : "build"} lines up with exports (${signed(exp.change, 0)} kb/d): a trade-flow move, which tends to reverse.`
        : runsDriven
          ? `The ${crudeChange < 0 ? "draw" : "build"} lines up with refinery runs (${signed(runs.change, 0)} kb/d): a domestic demand move.`
          : `Neither exports (${signed(exp.change, 0)} kb/d) nor refinery runs (${signed(runs.change, 0)} kb/d) moved enough to explain the ${crudeChange < 0 ? "draw" : "build"}; look at production, imports and the adjustment.`,
      cites: [C, exp.seriesId, runs.seriesId],
    });
  }
  if (cushing?.change !== undefined && Math.abs(crudeChange) >= 1 && Math.abs(cushing.change) >= 0.5 && Math.sign(cushing.change) !== Math.sign(crudeChange))
    add("checks", "Do the parts agree", { id: "cushing-vs-total", severity: "note", text: `Cushing ${dir(cushing.change, "built", "drew")} while national commercial stocks ${dir(crudeChange, "built", "drew")}: the NYMEX delivery point went the other way.`, cites: [cushing.seriesId, C] });

  return { report: "WPSR", weekEnding: new Date(report.periodEnd).toISOString().slice(0, 10), headline, sections: out };
}

export function analyzeWngsr(report: EiaReport, opts: AnalysisOptions = {}): ReportAnalysis | undefined {
  const total = report.rows.find((r) => r.headline);
  if (!total) return undefined;
  const threshold = opts.threshold ?? RULES.gasSurprise;
  const headline = headlineBlock("Lower 48 working gas in storage", "Bcf", total, threshold, opts.forecast, true);
  const { add, out } = sections();
  const T = total.seriesId;
  const change = total.change ?? 0;
  add("storage", "Storage", {
    id: "level",
    severity: "info",
    text: `Lower 48 storage ${dir(change, "rose", "fell")} ${fmt(change, 0)} Bcf to ${fmt(total.value, 0)} Bcf.`,
    cites: [T],
  });
  if (total.fiveYear !== undefined)
    add("storage", "Storage", {
      id: "five-year",
      severity: "info",
      text: `That is ${fmt(Math.abs(total.value - total.fiveYear), 0)} Bcf ${total.value >= total.fiveYear ? "above" : "below"} the 5-year average (${fmt(total.fiveYear, 0)} Bcf, ${total.fiveYearPct !== undefined ? signed(total.fiveYearPct, 1) : "n/a"}%)${total.yearAgo !== undefined ? ` and ${fmt(Math.abs(total.value - total.yearAgo), 0)} Bcf ${total.value >= total.yearAgo ? "above" : "below"} a year ago (${total.yearAgoPct !== undefined ? signed(total.yearAgoPct, 1) : "n/a"}%)` : ""}.`,
      cites: [T],
    });
  const regions = report.rows.filter((r) => !r.headline && !r.parent && r.change !== undefined);
  const biggest = [...regions].sort((a, b) => Math.abs(b.change!) - Math.abs(a.change!)).slice(0, 3);
  if (biggest.length)
    add("regions", "Regions", { id: "movers", severity: "info", text: `Biggest net changes: ${biggest.map((r) => `${r.label} ${signed(r.change!, 0)} Bcf`).join(", ")}.`, cites: biggest.map((r) => r.seriesId) });
  const gaps = regions.filter((r) => r.fiveYearPct !== undefined).sort((a, b) => Math.abs(b.fiveYearPct!) - Math.abs(a.fiveYearPct!));
  if (gaps.length)
    add("regions", "Regions", { id: "gaps", severity: "info", text: `Furthest from the 5-year average: ${gaps.slice(0, 3).map((r) => `${r.label} ${signed(r.fiveYearPct!, 1)}%`).join(", ")}.`, cites: gaps.slice(0, 3).map((r) => r.seriesId) });
  const south = report.rows.find((r) => r.label === "South Central");
  const salt = report.rows.find((r) => r.label === "Salt");
  if (south?.change !== undefined && salt?.change !== undefined)
    add("regions", "Regions", { id: "salt", severity: "note", text: `South Central ${signed(south.change, 0)} Bcf, of which salt caverns (which swing fastest with the weather) ${signed(salt.change, 0)} Bcf.`, cites: [south.seriesId, salt.seriesId] });
  const lead = regions.filter((r) => r.label !== "South Central").filter((r) => r.change! !== 0);
  if (lead.length >= 3) {
    const up = lead.filter((r) => r.change! > 0).length;
    add("checks", "Do the parts agree", { id: "breadth", severity: "info", text: up === lead.length ? "Every region added gas: a broad build." : up === 0 ? "Every region lost gas: a broad draw." : `Mixed: ${up} of ${lead.length} regions added gas.`, cites: lead.map((r) => r.seriesId) });
  }
  return { report: "WNGSR", weekEnding: new Date(report.periodEnd).toISOString().slice(0, 10), headline, sections: out };
}

/** The analysis of whichever report it is. */
export const analyzeReport = (report: EiaReport, opts: AnalysisOptions = {}) => (report.report === "WPSR" ? analyzeWpsr(report, opts) : analyzeWngsr(report, opts));
