// A release article for each EIA report (WPSR on Wednesday, WNGSR on Thursday): the facts of the release, the article our own rules write from them,
// the check that every figure in any article (ours or one Claude wrote over MCP) is in those facts, and the markdown for export.
//   facts    one flat set of rounded figures: the report's own rows, the history context, the forecast, the market reaction. Every figure an article may
//            use is in it, by path, and rounded the way an article prints it, so a cited value and a printed value agree.
//   article  { title, dek, sections: [{ heading, paragraphs: [{ text, cites }] }] }; each cite is {field, value} copied from the facts.
// The article states what the report says and what the market did. It gives no advice and no forecast of its own.
import { toNumber, matches as citeMatches, type Cite, type Issue } from "./grounding";
import { HISTORY_SERIES, type SeriesContext } from "./eiaHistory";
import type { EiaReport } from "./eiaReport";
import type { ReportAnalysis } from "./eiaAnalysis";
import type { Microstructure, Reaction } from "./releaseReaction";

// ---------------------------------------------------------------- facts

export interface SeriesNow {
  unit: string;
  level: number;
  prior?: number;
  change?: number;
  yearAgo?: number;
  yearAgoPct?: number;
  avg4?: number;
  fiveYear?: number;
  fiveYearPct?: number;
}

export interface ReactionFacts {
  label: string;
  /** decimals the price of the instrument is printed with */
  decimals: number;
  basePrice: number;
  moves: Record<string, { change: number; pct: number }>;
  maxUp15: number;
  maxDown15: number;
  firstSwing15: string;
  high60: number;
  low60: number;
  volumeFirst5: number;
  volumeRatio?: number;
  minutesCovered: number;
  micro?: Microstructure;
}

export interface ReleaseFacts {
  report: "WPSR" | "WNGSR";
  /** YYYY-MM-DD, the week the report covers */
  weekEnding: string;
  weekText: string;
  releasedAtIso?: string;
  /** seconds from the official release to the moment we stored it; absent for a backfilled report (the figure would only measure our downtime) */
  storedAfterSeconds?: number;
  forecast?: { value: number; source: string };
  headline: { label: string; unit: string; level: number; change: number; yearAgoPct?: number; forecast?: number; surprise?: number; threshold: number; side: string };
  series: Record<string, SeriesNow>;
  context: Record<string, SeriesContext>;
  reaction?: Record<string, ReactionFacts>;
  /** forecasts for the products (petroleum only) and the API's report the day before, from a third-party consensus; each surprise is the week's change minus the forecast */
  expect?: {
    gasoline?: { forecast: number; surprise: number };
    distillates?: { forecast: number; surprise: number };
    api?: { change: number; forecast?: number; surprise?: number; atIso: string };
  };
  /** what the article must say about its own limits */
  notes: string[];
}

/** The instruments whose reaction a release article reports, by the key used in the facts. */
export const REACTION_INSTRUMENTS: Record<"WPSR" | "WNGSR", { key: string; symbol: string; label: string; decimals: number }[]> = {
  WPSR: [
    { key: "cl", symbol: "NYMEX:CL", label: "NYMEX WTI", decimals: 2 },
    { key: "mcx_crude", symbol: "MCX:CRUDEOIL", label: "MCX crude oil", decimals: 0 },
  ],
  WNGSR: [
    { key: "ng", symbol: "NYMEX:NG", label: "NYMEX Henry Hub gas", decimals: 3 },
    { key: "mcx_gas", symbol: "MCX:NATURALGAS", label: "MCX natural gas", decimals: 1 },
  ],
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const weekText = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** Round a figure the way the article prints it: stocks in million barrels to one decimal (a change to two), flows to whole kb/d, percentages to one decimal, Bcf to whole. */
const round = (v: number | undefined, unit: string, isChange = false): number | undefined => {
  if (v === undefined || !Number.isFinite(v)) return undefined;
  const d = unit === "MB" || unit === "million barrels" ? (isChange ? 2 : 1) : unit === "%" ? 1 : 0;
  return Number(v.toFixed(d));
};

export interface FactsInput {
  report: EiaReport;
  analysis: ReportAnalysis;
  /** history context by series key, from the stored history (eiaHistory.ts) */
  context: Record<string, SeriesContext>;
  forecast?: { value: number; source: string };
  releasedAt?: number;
  storedAt?: number;
  backfilled?: boolean;
  /** consensus forecasts of the products' stock changes and the API's reported change (million barrels), when known */
  expectations?: { gasoline?: number; distillates?: number; api?: { change: number; forecast?: number; at: number } };
  reactions?: Record<string, { label: string; decimals?: number; reaction?: Reaction; micro?: Microstructure } | undefined>;
}

const unitOf = (u: string) => (/million barrels/i.test(u) ? "MB" : /kb\/d/i.test(u) ? "kb/d" : /^%$/.test(u) ? "%" : /bcf/i.test(u) ? "Bcf" : u);

export function buildFacts(input: FactsInput): ReleaseFacts {
  const { report, analysis } = input;
  const byId = new Map(report.rows.map((r) => [r.seriesId, r]));
  const series: Record<string, SeriesNow> = {};
  for (const s of HISTORY_SERIES.filter((x) => x.report === report.report)) {
    const r = byId.get(s.seriesId);
    if (!r) continue;
    const u = unitOf(r.unit);
    series[s.key] = {
      unit: u,
      level: round(r.value, u)!,
      prior: round(r.prior, u),
      change: round(r.change, u, true),
      yearAgo: round(r.yearAgo, u),
      yearAgoPct: round(r.yearAgoPct, "%"),
      avg4: round(r.avg4, u),
      fiveYear: round(r.fiveYear, u),
      fiveYearPct: round(r.fiveYearPct, "%"),
    };
  }
  const h = analysis.headline;
  const hu = unitOf(h.unit);
  const context: Record<string, SeriesContext> = {};
  const lagging: string[] = [];
  for (const [k, c] of Object.entries(input.context)) {
    // history that ends before the report's week would describe an earlier week next to this week's figures: leave it out and say so
    if (c.period < analysis.weekEnding) {
      lagging.push(k);
      continue;
    }
    const unit = series[k]?.unit ?? "";
    const rc = (v: number | undefined) => (v === undefined ? undefined : round(v, unit, true));
    const own = report.rows.find((r) => r.seriesId === HISTORY_SERIES.find((h) => h.key === k)?.seriesId);
    context[k] = {
      ...c,
      level: round(c.level, unit)!,
      change: rc(c.change),
      change4w: rc(c.change4w),
      change8w: rc(c.change8w),
      yearAgo: round(c.yearAgo, unit),
      vsYearAgo: rc(c.vsYearAgo),
      // where the report carries EIA's own five-year average (the gas file does) it replaces ours, so the article never gives two different averages
      fiveYear: c.fiveYear && {
        ...c.fiveYear,
        avg: round(own?.fiveYear ?? c.fiveYear.avg, unit)!,
        min: round(c.fiveYear.min, unit)!,
        max: round(c.fiveYear.max, unit)!,
        vsAvg: rc(own?.fiveYear !== undefined ? c.level - own.fiveYear : c.fiveYear.vsAvg)!,
        vsAvgPct: own?.fiveYearPct !== undefined ? round(own.fiveYearPct, "%") : c.fiveYear.vsAvgPct,
      },
      seasonalChange: c.seasonalChange && { ...c.seasonalChange, avg: rc(c.seasonalChange.avg)! },
    };
  }

  const expect: NonNullable<ReleaseFacts["expect"]> = {};
  if (report.report === "WPSR" && input.expectations) {
    const e = input.expectations;
    for (const [k, key] of [["gasoline", "gasoline"], ["distillates", "distillate"]] as const) {
      const f = e[k];
      const change = series[key]?.change;
      if (f !== undefined && change !== undefined) expect[k] = { forecast: round(f, "MB", true)!, surprise: round(change - f, "MB", true)! };
    }
    if (e.api) {
      const f = e.api.forecast;
      expect.api = { change: round(e.api.change, "MB", true)!, forecast: f === undefined ? undefined : round(f, "MB", true), surprise: f === undefined ? undefined : round(e.api.change - f, "MB", true), atIso: new Date(e.api.at).toISOString() };
    }
  }
  const notes: string[] = [];
  const reaction: Record<string, ReactionFacts> = {};
  for (const [key, x] of Object.entries(input.reactions ?? {})) {
    const r = x?.reaction;
    if (x && !r) notes.push(`No market reaction for ${x.label}: its one-minute candles around the release were not available.`);
    if (!x || !r) continue;
    const moves: ReactionFacts["moves"] = {};
    for (const m of r.moves) moves[`m${m.minutes}`] = { change: m.change, pct: m.pct };
    reaction[key] = {
      label: x.label,
      decimals: x.decimals ?? 2,
      basePrice: r.basePrice,
      moves,
      maxUp15: r.maxUp15,
      maxDown15: r.maxDown15,
      firstSwing15: r.firstSwing15,
      high60: r.high60,
      low60: r.low60,
      volumeFirst5: r.volumeFirst5,
      volumeRatio: r.volumeRatio,
      minutesCovered: r.minutesCovered,
      micro: x.micro,
    };
  }

  if (!input.forecast) notes.push("No forecast was on record for this release, so no surprise is calculated.");
  else notes.push(`The forecast is ${input.forecast.source}: a single figure, not an official consensus.`);
  if (lagging.length) notes.push(`EIA's weekly history had not caught up with this report for ${lagging.length} series (${lagging.slice(0, 4).join(", ")}), so their context is left out.`);
  if (report.report === "WPSR" && Object.values(context).some((c) => c.fiveYear)) notes.push("Five-year figures for crude and products are our own calculation from EIA's weekly history (the same week in each of the five previous years); EIA's published five-year averages can differ slightly.");
  if (Object.keys(expect).length) notes.push("Forecasts for gasoline and distillates, and the API's figures, are Investing.com's consensus: a single third-party figure, not an official one.");
  if (input.backfilled) notes.push("This report was stored after the fact, so the market reaction and our timing are measured from the official release time.");
  if (Object.values(reaction).some((x) => x.micro)) notes.push("Delta and book figures are estimates from our own recording of the Upstox feed (Upstox has no trade tape); spreads and counts are as recorded.");

  return {
    report: report.report,
    weekEnding: analysis.weekEnding,
    weekText: weekText(analysis.weekEnding),
    releasedAtIso: input.releasedAt ? new Date(input.releasedAt).toISOString() : undefined,
    storedAfterSeconds: input.storedAt && input.releasedAt && !input.backfilled ? Math.max(0, Math.round((input.storedAt - input.releasedAt) / 1000)) : undefined,
    forecast: input.forecast,
    headline: {
      label: h.label,
      unit: hu,
      level: round(h.level, hu)!,
      change: round(h.change, hu, true)!,
      yearAgoPct: round(h.yearAgoPct, "%"),
      forecast: h.forecast,
      surprise: h.surprise === undefined ? undefined : round(h.surprise, hu, true),
      threshold: h.threshold,
      side: h.side,
    },
    series,
    context,
    reaction: Object.keys(reaction).length ? reaction : undefined,
    expect: Object.keys(expect).length ? expect : undefined,
    notes,
  };
}

type Scalar = string | number;

const FIGURE = /(?<![\w.])[-−]?\d[\d,]*(?:\.\d+)?/g;

/**
 * Figures in prose that are in none of the known values. The facts are already rounded the way an article prints them, so a printed figure must equal a
 * known value rounded to the same number of decimals: far stricter than the briefing's half-percent tolerance, which would let 42.42 pass for 42.6.
 * Small whole numbers (counts, "four weeks") and years are ignored.
 */
export function looseArticleFigures(text: string, known: readonly number[]): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(FIGURE)) {
    const raw = m[0];
    const n = toNumber(raw);
    if (n === undefined) continue;
    if (Number.isInteger(n) && !raw.includes(".") && (Math.abs(n) < 100 || (n >= 1900 && n <= 2100))) continue;
    const decimals = raw.includes(".") ? raw.length - raw.indexOf(".") - 1 : 0;
    if (!known.some((k) => Number(Math.abs(k).toFixed(decimals)) === Math.abs(n))) bad.push(raw);
  }
  return bad;
}

/** Every figure and label an article may cite, by path (`series.crude.change`, `context.crude.fiveYear.avg`, `reaction.cl.moves.m5.pct`). */
export function citableFacts(facts: ReleaseFacts): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  const walk = (prefix: string, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out[prefix] = v;
    else if (typeof v === "string" && v && prefix !== "notes") out[prefix] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(`${prefix}.${k}`, x);
  };
  for (const [k, v] of Object.entries(facts)) if (k !== "notes") walk(k, v);
  return out;
}

// ---------------------------------------------------------------- the article

export interface ArticleParagraph {
  text: string;
  cites: Cite[];
}
export interface ArticleSection {
  heading: string;
  paragraphs: ArticleParagraph[];
}
export interface Article {
  title: string;
  dek: string;
  sections: ArticleSection[];
}

const abs = Math.abs;
const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "");
const fixed = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const ordinal = (n: number) => ({ 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth" })[n] ?? `${n}th`;
const word = (v: number, up: string, down: string, flat = "was unchanged") => (v > 0 ? up : v < 0 ? down : flat);
const get = (facts: ReleaseFacts, path: string): Scalar | undefined => citableFacts(facts)[path];

interface Figure {
  path: string;
  text: string;
}
type Part = string | Figure | Part[];
const flatten = (parts: Part[]): (string | Figure)[] => parts.flatMap((x) => (Array.isArray(x) ? flatten(x) : [x]));

/** Collects paragraphs whose cites are built from the facts as they stand, so a cite can never disagree with the figure it came from. */
class Writer {
  readonly sections: ArticleSection[] = [];
  private section?: ArticleSection;
  private fields = new Map<string, Scalar>();
  constructor(private facts: ReleaseFacts) {
    this.fields = new Map(Object.entries(citableFacts(facts)));
  }
  has(path: string) {
    return this.fields.has(path);
  }
  num(path: string): number | undefined {
    const v = this.fields.get(path);
    return typeof v === "number" ? v : undefined;
  }
  heading(h: string) {
    this.section = { heading: h, paragraphs: [] };
    this.sections.push(this.section);
  }
  /** `parts` are plain strings and `{path, text}` figures (nested lists are flattened); every figure becomes a cite. Writes nothing when a needed figure is missing. */
  p(...parts: Part[]) {
    const cites: Cite[] = [];
    let text = "";
    for (const part of flatten(parts)) {
      if (typeof part === "string") text += part;
      else {
        const v = this.fields.get(part.path);
        if (v === undefined) return;
        text += part.text;
        cites.push({ field: part.path, value: String(v) });
      }
    }
    this.section!.paragraphs.push({ text: text.replace(/\s+/g, " ").trim(), cites });
  }
  /** A figure printed as it is rounded in the facts: `f("series.crude.level", 1)`. */
  f(path: string, decimals: number, opts: { abs?: boolean; sign?: boolean } = {}): { path: string; text: string } {
    const v = this.num(path);
    return { path, text: v === undefined ? "" : opts.sign ? `${sign(v)}${fixed(abs(v), decimals)}` : fixed(opts.abs ? abs(v) : v, decimals) };
  }
  done(title: string, dek: string): Article {
    return { title, dek, sections: this.sections.filter((s) => s.paragraphs.length) };
  }
}

function reactionSection(w: Writer, facts: ReleaseFacts) {
  const rx = facts.reaction;
  if (!rx) return;
  w.heading("How the market reacted");
  for (const [key, x] of Object.entries(rx)) {
    const base = `reaction.${key}`;
    const m1 = x.moves.m1;
    const m5 = x.moves.m5;
    const m15 = x.moves.m15;
    const m60 = x.moves.m60;
    const dec = (v: number) => fixed(abs(v), 2);
    const px = (v: number) => fixed(abs(v), x.decimals);
    const parts: Part[] = [`${x.label} was at ${fixed(x.basePrice, x.decimals)} just before the release. `];
    if (m1) parts.push(`A minute later it was ${word(m1.change, "up", "down", "unchanged")} `, { path: `${base}.moves.m1.pct`, text: `${dec(m1.pct)}%` }, "; ");
    if (m5) parts.push("after five minutes ", { path: `${base}.moves.m5.pct`, text: `${sign(m5.pct)}${dec(m5.pct)}%` });
    if (m15) parts.push(", after fifteen ", { path: `${base}.moves.m15.pct`, text: `${sign(m15.pct)}${dec(m15.pct)}%` });
    if (m60 && x.minutesCovered >= 60) parts.push(" and after an hour ", { path: `${base}.moves.m60.pct`, text: `${sign(m60.pct)}${dec(m60.pct)}%` });
    parts.push(".");
    w.p(...parts);
    if (x.maxUp15 > 0 || x.maxDown15 > 0) {
      w.p(
        `In the first fifteen minutes it reached `,
        { path: `${base}.maxUp15`, text: px(x.maxUp15) },
        " above and ",
        { path: `${base}.maxDown15`, text: px(x.maxDown15) },
        ` below that level, the ${x.firstSwing15 === "none" ? "" : x.firstSwing15 + " "}move coming first`,
        x.volumeRatio !== undefined ? [`; volume in the first five minutes was `, { path: `${base}.volumeRatio`, text: `${fixed(x.volumeRatio, 1)} times` }, " the average five minutes of the hour before"].flat() : [],
        ".",
      );
    }
    const mi = x.micro;
    if (mi && mi.spreadBefore !== undefined && mi.spreadAfter !== undefined) {
      w.p(
        "From our recording of the feed, the average bid-ask spread went from ",
        { path: `${base}.micro.spreadBefore`, text: fixed(mi.spreadBefore, 2) },
        " in the five minutes before to ",
        { path: `${base}.micro.spreadAfter`, text: fixed(mi.spreadAfter, 2) },
        " in the five minutes after",
        mi.spreadWidest !== undefined ? [", widest in a single minute at ", { path: `${base}.micro.spreadWidest`, text: fixed(mi.spreadWidest, 2) }].flat() : [],
        mi.deltaFirst5 !== 0 ? [`. Estimated buying minus selling volume over the first five minutes was `, { path: `${base}.micro.deltaFirst5`, text: `${sign(mi.deltaFirst5)}${fixed(abs(mi.deltaFirst5), 0)}` }, " lots (an estimate)"].flat() : [],
        ".",
      );
    }
  }
}

function notesSection(w: Writer, facts: ReleaseFacts) {
  w.heading("About these figures");
  const src = facts.report === "WPSR" ? "EIA's Weekly Petroleum Status Report" : "EIA's Weekly Natural Gas Storage Report";
  w.p(`Figures are from ${src}${facts.releasedAtIso ? `, released ${facts.releasedAtIso.slice(0, 16).replace("T", " ")} UTC` : ""}, with weekly history from EIA's Open Data API and prices from candles our own system recorded. This is a research summary of what the report shows, not advice.`);
  for (const n of facts.notes) w.p(n);
}

function wpsr(facts: ReleaseFacts): Article {
  const w = new Writer(facts);
  const h = facts.headline;
  const c = facts.context;
  const dirTitle = word(h.change, "builds", "draws", "is unchanged");
  w.heading("The headline");
  w.p(
    `Commercial crude oil inventories ${word(h.change, "built", "drew")} `,
    w.f("headline.change", 2, { abs: true }),
    ` million barrels in the week ending ${facts.weekText}, to `,
    w.f("headline.level", 1),
    " million barrels",
    h.yearAgoPct !== undefined ? [", ", w.f("headline.yearAgoPct", 1, { abs: true }), `% ${h.yearAgoPct < 0 ? "below" : "above"} a year ago`].flat() : [],
    h.forecast !== undefined && h.surprise !== undefined
      ? [`. The forecast on record (${facts.forecast?.source ?? "source unknown"}) was `, w.f("headline.forecast", 2, { sign: true }), " million barrels, a surprise of ", w.f("headline.surprise", 2, { sign: true })].flat()
      : ". No forecast was on record, so no surprise is calculated",
    ".",
  );
  if (h.surprise !== undefined) {
    w.p(
      "The report-day rule in this app needs a surprise of at least ",
      w.f("headline.threshold", 1),
      " million barrels: this one ",
      abs(h.surprise) >= h.threshold ? `reaches it, and the rule's allowed side is ${h.side}` : "does not reach it, so the rule allows no side",
      ". That is a mechanical check of the app's rule, not a recommendation.",
    );
  }

  const api = facts.expect?.api;
  if (api) {
    w.p(
      `The API reported a ${word(api.change, "build", "draw")} of `,
      { path: "expect.api.change", text: `${fixed(abs(api.change), 2)} million barrels` },
      " the day before",
      api.forecast !== undefined ? [", against a forecast of ", { path: "expect.api.forecast", text: `${sign(api.forecast)}${fixed(abs(api.forecast), 2)}` }].flat() : [],
      "; EIA's figure for the week was ",
      { path: "headline.change", text: `${sign(h.change)}${fixed(abs(h.change), 2)}` },
      " million barrels.",
    );
  }

  w.heading("In context");
  const cc = c.crude;
  if (cc?.streak && cc.streak.weeks >= 2 && cc.streak.direction !== "flat") w.p(`This is the ${ordinal(cc.streak.weeks)} ${cc.streak.direction === "draw" ? "weekly draw" : "weekly build"} in a row for commercial crude.`, { path: "context.crude.streak.weeks", text: "" });
  if (cc?.change4w !== undefined && cc.change8w !== undefined) {
    w.p("Over four weeks commercial crude stocks have ", word(cc.change4w, "risen", "fallen", "not moved"), " ", { path: "context.crude.change4w", text: fixed(abs(cc.change4w), 2) }, " million barrels, and over eight weeks ", { path: "context.crude.change8w", text: `${fixed(abs(cc.change8w), 2)} million barrels ${word(cc.change8w, "higher", "lower", "unchanged")}` }, ".");
  }
  if (cc?.fiveYear) {
    const fy = cc.fiveYear;
    w.p(
      "Stocks are ",
      { path: "context.crude.fiveYear.vsAvg", text: fixed(abs(fy.vsAvg), 1) },
      " million barrels",
      fy.vsAvgPct !== undefined ? [" (", { path: "context.crude.fiveYear.vsAvgPct", text: `${fixed(abs(fy.vsAvgPct), 1)}%` }, ")"].flat() : [],
      ` ${fy.vsAvg < 0 ? "below" : "above"} the five-year average for this week of `,
      { path: "context.crude.fiveYear.avg", text: fixed(fy.avg, 1) },
      fy.position !== undefined ? (fy.position <= 0.15 ? ", near the bottom of the five-year range" : fy.position >= 0.85 ? ", near the top of the five-year range" : ", inside the five-year range") : "",
      ".",
    );
  }
  if (cc?.seasonalChange && cc.change !== undefined) {
    const sc = cc.seasonalChange.avg;
    w.p(
      `In this week of the year stocks have usually ${sc < 0 ? "drawn" : "built"} about `,
      { path: "context.crude.seasonalChange.avg", text: fixed(abs(sc), 2) },
      " million barrels over the last five years; this week's move was ",
      abs(cc.change - sc) < 0.5 ? "close to that" : (h.change < sc ? "a larger draw" : "a smaller draw") + " than the seasonal norm",
      ".",
    );
  }
  if (cc?.lowestInWeeks !== undefined && cc.lowestInWeeks >= 26) w.p("Commercial crude stocks are at their lowest in ", { path: "context.crude.lowestInWeeks", text: `${cc.lowestInWeeks} weeks` }, ".");
  else if (cc?.highestInWeeks !== undefined && cc.highestInWeeks >= 26) w.p("Commercial crude stocks are at their highest in ", { path: "context.crude.highestInWeeks", text: `${cc.highestInWeeks} weeks` }, ".");
  const cu = facts.series.cushing;
  if (cu?.change !== undefined) {
    w.p(
      "Cushing, the delivery point of the NYMEX contract, ",
      word(cu.change, "built", "drew"),
      " ",
      { path: "series.cushing.change", text: fixed(abs(cu.change), 2) },
      " million barrels to ",
      { path: "series.cushing.level", text: `${fixed(cu.level, 1)} million barrels` },
      c.cushing?.fiveYear ? [", ", { path: "context.cushing.fiveYear.vsAvg", text: fixed(abs(c.cushing.fiveYear.vsAvg), 1) }, ` million barrels ${c.cushing.fiveYear.vsAvg < 0 ? "below" : "above"} its five-year average`].flat() : [],
      ".",
    );
  }
  const spr = facts.series.spr;
  const tot = facts.series.crude_total;
  if (spr?.change !== undefined && tot?.change !== undefined) {
    w.p("The Strategic Petroleum Reserve ", word(spr.change, "rose", "fell", "was unchanged"), " ", { path: "series.spr.change", text: fixed(abs(spr.change), 2) }, " million barrels to ", { path: "series.spr.level", text: `${fixed(spr.level, 1)} million barrels` }, ", so crude including the reserve moved ", { path: "series.crude_total.change", text: `${sign(tot.change)}${fixed(abs(tot.change), 2)}` }, " million barrels.");
  }

  w.heading("What moved it");
  const flow = (key: string, name: string) => {
    const s = facts.series[key];
    if (!s || s.change === undefined) return;
    w.p(
      `${name} ${word(s.change, "rose", "fell", "were unchanged")} `,
      { path: `series.${key}.change`, text: fixed(abs(s.change), 0) },
      " thousand barrels a day to ",
      { path: `series.${key}.level`, text: `${fixed(s.level, 0)} thousand barrels a day` },
      s.yearAgo !== undefined ? [", against ", { path: `series.${key}.yearAgo`, text: fixed(s.yearAgo, 0) }, " a year ago"].flat() : [],
      ".",
    );
  };
  flow("exports", "Crude exports");
  flow("imports", "Crude imports");
  flow("production", "Domestic crude production");
  const run = facts.series.runs;
  const util = facts.series.utilisation;
  if (util?.change !== undefined) {
    w.p("Refineries ran at ", { path: "series.utilisation.level", text: `${fixed(util.level, 1)}%` }, " of capacity, ", word(util.change, "up", "down", "unchanged"), " ", { path: "series.utilisation.change", text: fixed(abs(util.change), 1) }, " points on the week", run ? [", with crude inputs of ", { path: "series.runs.level", text: fixed(run.level, 0) }, " thousand barrels a day"].flat() : [], ".");
  }

  w.heading("Products");
  for (const [stock, demand, name] of [["gasoline", "gasoline_demand", "Gasoline"], ["distillate", "distillate_demand", "Distillate"], ["jet", "jet_demand", "Jet fuel"]] as const) {
    const st = facts.series[stock];
    if (st?.change === undefined) continue;
    const d = facts.series[demand];
    const exp = stock === "gasoline" ? (facts.expect?.gasoline ? "gasoline" : undefined) : stock === "distillate" ? (facts.expect?.distillates ? "distillates" : undefined) : undefined;
    w.p(
      `${name} stocks ${word(st.change, "built", "drew")} `,
      { path: `series.${stock}.change`, text: fixed(abs(st.change), 2) },
      " million barrels to ",
      { path: `series.${stock}.level`, text: `${fixed(st.level, 1)} million barrels` },
      c[stock]?.fiveYear ? [", ", { path: `context.${stock}.fiveYear.vsAvg`, text: fixed(abs(c[stock].fiveYear!.vsAvg), 1) }, ` ${c[stock].fiveYear!.vsAvg < 0 ? "below" : "above"} the five-year average`].flat() : [],
      exp ? [`; the forecast was `, { path: `expect.${exp}.forecast`, text: `${sign(facts.expect![exp]!.forecast)}${fixed(abs(facts.expect![exp]!.forecast), 2)}` }, " (a surprise of ", { path: `expect.${exp}.surprise`, text: `${sign(facts.expect![exp]!.surprise)}${fixed(abs(facts.expect![exp]!.surprise), 2)}` }, ")"].flat() : [],
      d?.change !== undefined ? ["; demand (product supplied) was ", { path: `series.${demand}.level`, text: fixed(d.level, 0) }, " thousand barrels a day, ", word(d.change, "up ", "down ", "unchanged"), { path: `series.${demand}.change`, text: fixed(abs(d.change), 0) }, " on the week"].flat() : [],
      ".",
    );
  }

  reactionSection(w, facts);
  notesSection(w, facts);
  const title = `EIA petroleum report: crude ${dirTitle} ${fixed(abs(h.change), 2)} million barrels`;
  const dek =
    h.forecast !== undefined && h.surprise !== undefined
      ? `Week ending ${facts.weekText}: commercial crude ${word(h.change, "built", "drew")} ${fixed(abs(h.change), 2)} million barrels against a forecast of ${sign(h.forecast)}${fixed(abs(h.forecast), 2)}.`
      : `Week ending ${facts.weekText}: commercial crude stocks ${word(h.change, "built", "drew")} ${fixed(abs(h.change), 2)} million barrels to ${fixed(h.level, 1)} million.`;
  return w.done(title, dek);
}

function wngsr(facts: ReleaseFacts): Article {
  const w = new Writer(facts);
  const h = facts.headline;
  const g = facts.series.gas_total;
  const gc = facts.context.gas_total;
  const verb = word(h.change, "rose", "fell", "was unchanged");
  w.heading("The headline");
  w.p(
    `Working gas in storage in the Lower 48 ${verb} `,
    w.f("headline.change", 0, { abs: true }),
    ` Bcf in the week ending ${facts.weekText}, to `,
    w.f("headline.level", 0),
    " Bcf",
    g?.fiveYear !== undefined && g.fiveYearPct !== undefined ? [", ", { path: "series.gas_total.fiveYearPct", text: `${fixed(abs(g.fiveYearPct), 1)}%` }, ` ${g.fiveYearPct < 0 ? "below" : "above"} the five-year average and `, g.yearAgo !== undefined ? [{ path: "series.gas_total.yearAgo", text: fixed(g.yearAgo, 0) }, " Bcf a year ago"].flat() : ""].flat() : [],
    h.forecast !== undefined && h.surprise !== undefined
      ? [`. The forecast on record (${facts.forecast?.source ?? "source unknown"}) was `, w.f("headline.forecast", 0, { sign: true }), " Bcf, a surprise of ", w.f("headline.surprise", 0, { sign: true })].flat()
      : ". No forecast was on record, so no surprise is calculated",
    ".",
  );
  if (h.surprise !== undefined) {
    w.p("The report-day rule in this app needs a surprise of at least ", w.f("headline.threshold", 1), " Bcf: this one ", abs(h.surprise) >= h.threshold ? `reaches it, and the rule's allowed side is ${h.side}` : "does not reach it, so the rule allows no side", ". That is a mechanical check of the app's rule, not a recommendation.");
  }

  w.heading("In context");
  if (gc?.streak && gc.streak.weeks >= 2 && gc.streak.direction !== "flat") w.p(`This is the ${ordinal(gc.streak.weeks)} ${gc.streak.direction === "build" ? "weekly injection" : "weekly withdrawal"} in a row.`, { path: "context.gas_total.streak.weeks", text: "" });
  if (gc?.seasonalChange && gc.change !== undefined) {
    const sc = gc.seasonalChange.avg;
    w.p("The same week has averaged ", { path: "context.gas_total.seasonalChange.avg", text: `${sign(sc)}${fixed(abs(sc), 0)}` }, " Bcf over the last five years; this week's ", { path: "context.gas_total.change", text: `${sign(gc.change)}${fixed(abs(gc.change), 0)}` }, " Bcf was ", abs(gc.change - sc) <= 3 ? "close to that" : gc.change > sc ? "a larger injection than the seasonal norm" : "a smaller injection than the seasonal norm", ".");
  }
  if (gc?.fiveYear) {
    const fy = gc.fiveYear;
    w.p("Storage is ", { path: "context.gas_total.fiveYear.vsAvg", text: fixed(abs(fy.vsAvg), 0) }, ` Bcf ${fy.vsAvg < 0 ? "below" : "above"} the five-year average for this week of `, { path: "context.gas_total.fiveYear.avg", text: fixed(fy.avg, 0) }, " Bcf", fy.position !== undefined ? (fy.position <= 0.15 ? ", near the bottom of the five-year range" : fy.position >= 0.85 ? ", near the top of the five-year range" : ", inside the five-year range") : "", ".");
  }
  if (gc?.lowestInWeeks !== undefined && gc.lowestInWeeks >= 26) w.p("Storage is at its lowest in ", { path: "context.gas_total.lowestInWeeks", text: `${gc.lowestInWeeks} weeks` }, ".");
  else if (gc?.highestInWeeks !== undefined && gc.highestInWeeks >= 26) w.p("Storage is at its highest in ", { path: "context.gas_total.highestInWeeks", text: `${gc.highestInWeeks} weeks` }, ".");

  w.heading("By region");
  const regions = (["gas_east", "gas_midwest", "gas_south_central", "gas_mountain", "gas_pacific"] as const)
    .map((k) => ({ k, name: { gas_east: "East", gas_midwest: "Midwest", gas_south_central: "South Central", gas_mountain: "Mountain", gas_pacific: "Pacific" }[k], s: facts.series[k] }))
    .filter((r) => r.s?.change !== undefined)
    .sort((a, b) => abs(b.s!.change!) - abs(a.s!.change!));
  for (const r of regions.slice(0, 3)) {
    w.p(`${r.name} storage ${word(r.s!.change!, "rose", "fell", "was unchanged")} `, { path: `series.${r.k}.change`, text: fixed(abs(r.s!.change!), 0) }, " Bcf to ", { path: `series.${r.k}.level`, text: fixed(r.s!.level, 0) }, " Bcf", r.s!.yearAgo !== undefined ? [", against ", { path: `series.${r.k}.yearAgo`, text: fixed(r.s!.yearAgo, 0) }, " a year ago"].flat() : [], ".");
  }
  const salt = facts.series.gas_salt;
  if (salt?.change !== undefined) w.p("Salt cavern storage, which can be cycled quickly, ", word(salt.change, "rose", "fell", "was unchanged"), " ", { path: "series.gas_salt.change", text: fixed(abs(salt.change), 0) }, " Bcf to ", { path: "series.gas_salt.level", text: fixed(salt.level, 0) }, " Bcf.");

  reactionSection(w, facts);
  notesSection(w, facts);
  const title = `EIA gas storage: ${word(h.change, "injection of", "withdrawal of", "no change,")} ${fixed(abs(h.change), 0)} Bcf`;
  const dek =
    h.forecast !== undefined && h.surprise !== undefined
      ? `Week ending ${facts.weekText}: storage ${verb} ${fixed(abs(h.change), 0)} Bcf against a forecast of ${sign(h.forecast)}${fixed(abs(h.forecast), 0)}, to ${fixed(h.level, 0)} Bcf.`
      : `Week ending ${facts.weekText}: storage ${verb} ${fixed(abs(h.change), 0)} Bcf to ${fixed(h.level, 0)} Bcf.`;
  return w.done(title, dek);
}

/** The article our own rules write from the facts: the same facts always give the same article, and every figure in it is cited. */
export const buildArticle = (facts: ReleaseFacts): Article => (facts.report === "WPSR" ? wpsr(facts) : wngsr(facts));

// ---------------------------------------------------------------- checking

export interface ParagraphCheck {
  section: number;
  index: number;
  verdict: "verified" | "wrong" | "unverified";
  issues: Issue[];
}
export interface ArticleCheck {
  paragraphs: ParagraphCheck[];
  total: number;
  verified: number;
  wrong: number;
  /** problems in the title and dek */
  other: Issue[];
}

/**
 * Every cite is resolved against the facts and compared; the text is scanned for figures that are in neither the facts nor the cites. A paragraph is
 * `wrong` when a cite contradicts the facts, `unverified` when nothing is wrong but it could not be fully checked (no cite, or a loose figure).
 */
export function checkArticle(article: Article, facts: ReleaseFacts): ArticleCheck {
  const fields = citableFacts(facts);
  const known = Object.values(fields).filter((v): v is number => typeof v === "number");
  const paragraphs: ParagraphCheck[] = [];
  article.sections.forEach((section, si) =>
    section.paragraphs.forEach((p, index) => {
      const issues: Issue[] = [];
      for (const c of p.cites) {
        if (!(c.field in fields)) issues.push({ kind: "wrong", text: `"${c.field}" is not a field in the facts.` });
        else if (!citeMatches(fields[c.field]!, c.value)) issues.push({ kind: "wrong", text: `${c.field} is ${fields[c.field]}, not ${c.value}.` });
      }
      if (p.cites.length === 0 && looseArticleFigures(p.text, []).length > 0) issues.push({ kind: "loose", text: "Figures here cite no field." });
      const citedNumbers = p.cites.map((c) => toNumber(c.value)).filter((n): n is number => n !== undefined);
      for (const f of looseArticleFigures(p.text, [...known, ...citedNumbers])) issues.push({ kind: "loose", text: `${f} is not in the facts.` });
      paragraphs.push({ section: si, index, issues, verdict: issues.some((i) => i.kind === "wrong") ? "wrong" : issues.length ? "unverified" : "verified" });
    }),
  );
  const other = looseArticleFigures(`${article.title} ${article.dek}`, known).map((f) => ({ kind: "loose" as const, text: `${f} is not in the facts.` }));
  return { paragraphs, total: paragraphs.length, verified: paragraphs.filter((x) => x.verdict === "verified").length, wrong: paragraphs.filter((x) => x.verdict === "wrong").length, other };
}

// ---------------------------------------------------------------- submission and export

export interface ArticleSubmission {
  report: "WPSR" | "WNGSR";
  contextId: string;
  article: Article;
}

const str = (v: unknown, min: number, max: number): string | undefined => (typeof v === "string" && v.trim().length >= min && v.length <= max ? v.trim() : undefined);

/** Validate an article an agent submitted: shape, counts and lengths, with the reason when it is refused. */
export function parseArticleSubmission(body: unknown): { submission: ArticleSubmission } | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (b.report !== "WPSR" && b.report !== "WNGSR") return { error: "report must be WPSR or WNGSR" };
  const contextId = str(b.context_id, 1, 64);
  if (!contextId) return { error: "context_id is required: call get_eia_release_context first and pass its context_id" };
  const title = str(b.title, 1, 160);
  if (!title) return { error: "title must be 1 to 160 characters" };
  const dek = str(b.dek, 1, 320);
  if (!dek) return { error: "dek must be 1 to 320 characters" };
  if (!Array.isArray(b.sections) || b.sections.length < 1 || b.sections.length > 8) return { error: "sections must be a list of 1 to 8" };
  const sections: ArticleSection[] = [];
  for (const [si, s] of b.sections.entries()) {
    const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    const heading = str(o.heading, 1, 80);
    if (!heading) return { error: `section ${si + 1}: heading must be 1 to 80 characters` };
    if (!Array.isArray(o.paragraphs) || o.paragraphs.length < 1 || o.paragraphs.length > 8) return { error: `section ${si + 1}: paragraphs must be a list of 1 to 8` };
    const paragraphs: ArticleParagraph[] = [];
    for (const [pi, pr] of o.paragraphs.entries()) {
      const po = (pr && typeof pr === "object" ? pr : {}) as Record<string, unknown>;
      const text = str(po.text, 1, 900);
      if (!text) return { error: `section ${si + 1}, paragraph ${pi + 1}: text must be 1 to 900 characters` };
      const raw = Array.isArray(po.cites) ? po.cites : [];
      if (raw.length > 8) return { error: `section ${si + 1}, paragraph ${pi + 1}: at most 8 cites` };
      const cites: Cite[] = [];
      for (const c of raw) {
        const field = str((c as Record<string, unknown>)?.field, 1, 120);
        const value = str((c as Record<string, unknown>)?.value, 1, 200);
        if (!field || !value) return { error: `section ${si + 1}, paragraph ${pi + 1}: each cite needs a field and a value` };
        cites.push({ field, value });
      }
      paragraphs.push({ text, cites });
    }
    sections.push({ heading, paragraphs });
  }
  return { submission: { report: b.report, contextId, article: { title, dek, sections } } };
}

/** What the agent is told alongside the facts, so it knows the contract. */
export const AGENT_ARTICLE_INSTRUCTIONS = `You are writing a release article for the Divya Drishti app about one EIA report. The "facts" hold every figure; "citable" lists each by path.
1. Write the article from the facts only: a title, a one-sentence dek, and sections of short paragraphs (what the report says, the context from history, what moved it, how the market reacted when the facts include it).
2. Give each paragraph "cites": the {field, value} pairs for the figures it uses, copied exactly from "citable". Print each figure exactly as it appears in the facts (they are rounded for print); do not write a number that is not in "citable".
3. State what happened. Give no trade advice and no forecast of your own, and say "estimated" for anything under reaction.*.micro delta or book. The facts' "notes" must be reflected in a closing paragraph.
4. Call submit_eia_article with the same context_id. It returns the verdict per paragraph: correct any paragraph marked wrong and submit again.`;

/** The article as markdown, for export. */
export function articleMarkdown(article: Article, meta: { source: string; check?: { verified: number; total: number } }): string {
  const lines = [`# ${article.title}`, "", `*${article.dek}*`, ""];
  for (const s of article.sections) {
    lines.push(`## ${s.heading}`, "");
    for (const p of s.paragraphs) lines.push(p.text, "");
  }
  lines.push("---", `*${meta.source}${meta.check ? ` · ${meta.check.verified} of ${meta.check.total} paragraphs checked against the data` : ""}.*`);
  return lines.join("\n");
}
