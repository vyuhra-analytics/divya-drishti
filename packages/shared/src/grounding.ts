// Grounding: every claim in an AI briefing is checked against the facts we gave the model, by code, not by asking the model again.
// The model must cite each bull/bear point as {field, value} copied from `citableFields(ctx)`; `checkBriefing` resolves each cite and
// compares the value, and scans the prose for figures that are not in the data. Pure, so the rules are tested.
import type { BriefingContext, BriefingResult } from "./briefing";

export interface Cite {
  /** a key of `citableFields`, e.g. "technicals.rsi14", "news.3" */
  field: string;
  /** the value as the model read it from that field, as text: "71.2", "Brent climbs" */
  value: string;
}

export interface Issue {
  /** "wrong": a cited value contradicts the data (or names a field that does not exist). "loose": prose carries a figure that is not in the data, or a point has nothing to check. */
  kind: "wrong" | "loose";
  text: string;
}

export interface PointCheck {
  section: "bull" | "bear";
  index: number;
  /** verified = every cite matches and no loose figures; wrong = a cite contradicts the data; unverified = nothing contradicts it but it could not be fully checked */
  verdict: "verified" | "wrong" | "unverified";
  issues: Issue[];
}

export interface GroundingReport {
  points: PointCheck[];
  /** problems in the summary, watch list and data gaps */
  other: Issue[];
  verified: number;
  total: number;
  wrong: number;
}

type Scalar = string | number;

/** Every fact the model may cite, by path. Headlines and events are numbered as they appear in the context (`news.3`, `events.1`). */
export function citableFields(ctx: BriefingContext): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  const walk = (prefix: string, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out[prefix] = v;
    else if (typeof v === "string" && v) out[prefix] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(`${prefix}.${k}`, x);
  };
  for (const [k, v] of Object.entries(ctx)) {
    if (k === "asOf" || k === "news" || k === "events" || k === "provenance") continue;
    walk(k, v);
  }
  for (const [group, p] of Object.entries(ctx.provenance)) {
    if (!p) continue;
    out[`provenance.${group}.quality`] = p.quality;
    out[`provenance.${group}.source`] = p.source;
    if (p.conflict) walk(`provenance.${group}.conflict`, { pct: p.conflict.pct, ticks: p.conflict.ticks });
  }
  for (const n of ctx.news) {
    out[`news.${n.n}`] = n.title;
    out[`news.${n.n}.ageMin`] = n.ageMin;
  }
  ctx.events.forEach((e, i) => {
    out[`events.${i + 1}`] = e.title;
    out[`events.${i + 1}.inMin`] = e.inMin;
    if (e.forecast) out[`events.${i + 1}.forecast`] = e.forecast;
    if (e.previous) out[`events.${i + 1}.previous`] = e.previous;
  });
  return out;
}

const toNumber = (s: Scalar): number | undefined => {
  if (typeof s === "number") return s;
  const n = Number(s.replace(/[,%\s]/g, "").replace(/^[+−–]/, (m) => (m === "+" ? "" : "-")));
  return s.trim() !== "" && Number.isFinite(n) ? n : undefined;
};
/** Equal after rounding: within half a percent, or a hundredth for tiny values. */
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.005);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Does the value the model quoted for a field match the data? */
function matches(actual: Scalar, quoted: string): boolean {
  if (typeof actual === "number") {
    const q = toNumber(quoted);
    return q !== undefined && close(actual, q);
  }
  const [a, q] = [norm(actual), norm(quoted)];
  return q.length > 0 && (a === q || (q.length >= 8 && a.includes(q)) || (a.length >= 8 && q.includes(a))); // a headline may be quoted in part
}

const NUMBER = /(?<![\w.])[-−]?\d[\d,]*(?:\.\d+)?/g;

/** Figures in prose that are not in the data. Small whole numbers (counts, "14-period") and years are ignored. */
function looseFigures(text: string, known: number[]): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const raw = m[0];
    const n = toNumber(raw);
    if (n === undefined) continue;
    if (Number.isInteger(n) && !raw.includes(".") && (Math.abs(n) < 100 || (n >= 1900 && n <= 2100))) continue;
    if (!known.some((k) => close(Math.abs(k), Math.abs(n)))) bad.push(raw);
  }
  return bad;
}

/** Check a briefing against the context it was written from. */
export function checkBriefing(result: BriefingResult, ctx: BriefingContext): GroundingReport {
  const fields = citableFields(ctx);
  const known = Object.values(fields).filter((v): v is number => typeof v === "number");
  const points: PointCheck[] = [];

  for (const section of ["bull", "bear"] as const) {
    result[section].forEach((p, index) => {
      const issues: Issue[] = [];
      const cites = p.cites ?? [];
      if (cites.length === 0) issues.push({ kind: "loose", text: "No data cited for this point." });
      for (const c of cites) {
        if (!(c.field in fields)) issues.push({ kind: "wrong", text: `"${c.field}" is not a field in the data.` });
        else if (!matches(fields[c.field]!, c.value)) issues.push({ kind: "wrong", text: `${c.field} is ${fields[c.field]}, not ${c.value}.` });
      }
      const citedNumbers = cites.map((c) => toNumber(c.value)).filter((n): n is number => n !== undefined);
      for (const f of looseFigures(`${p.point} ${p.evidence}`, [...known, ...citedNumbers])) issues.push({ kind: "loose", text: `${f} is not in the data.` });
      points.push({ section, index, issues, verdict: issues.some((i) => i.kind === "wrong") ? "wrong" : issues.length ? "unverified" : "verified" });
    });
  }

  const other: Issue[] = [];
  for (const f of looseFigures([result.summary, ...result.watch, ...result.data_gaps].join(" "), known)) other.push({ kind: "loose", text: `${f} is not in the data.` });
  const q = ctx.provenance.price.quality;
  if ((q === "delayed" || q === "stale" || q === "closed") && /\b(live|real-?time|right now)\b/i.test(result.summary) && !/\b(not live|delayed|stale|closed|behind|last price)\b/i.test(result.summary)) {
    other.push({ kind: "loose", text: `The price is ${q}, but the summary calls it live.` });
  }

  return {
    points,
    other,
    total: points.length,
    verified: points.filter((p) => p.verdict === "verified").length,
    wrong: points.filter((p) => p.verdict === "wrong").length,
  };
}

/** What to tell the model when its first answer cited something that is not true, so it can correct exactly that. */
export function groundingFeedback(report: GroundingReport): string {
  const lines = report.points.filter((p) => p.verdict === "wrong").flatMap((p) => p.issues.filter((i) => i.kind === "wrong").map((i) => `- ${p.section} point ${p.index + 1}: ${i.text}`));
  return `Your briefing cites facts that do not match the data:\n${lines.join("\n")}\nWrite the briefing again. Copy each cited value exactly from the citable fields, and drop any point you cannot support.`;
}

export interface Grounded {
  result: BriefingResult;
  report: GroundingReport;
  /** model calls used: 1, or 2 when the first answer cited something wrong */
  attempts: number;
}

/**
 * Ask for a briefing, check it, and when it cites something that contradicts the data ask once more with exactly what was wrong.
 * The better of the two answers (fewer wrong cites, then more verified points) is returned; a failed second call keeps the first.
 */
export async function writeGrounded(ctx: BriefingContext, ask: (feedback?: string) => Promise<BriefingResult>): Promise<Grounded> {
  const first = await ask();
  const firstReport = checkBriefing(first, ctx);
  if (firstReport.wrong === 0) return { result: first, report: firstReport, attempts: 1 };
  try {
    const second = await ask(groundingFeedback(firstReport));
    const secondReport = checkBriefing(second, ctx);
    const better = secondReport.wrong < firstReport.wrong || (secondReport.wrong === firstReport.wrong && secondReport.verified >= firstReport.verified);
    return better ? { result: second, report: secondReport, attempts: 2 } : { result: first, report: firstReport, attempts: 2 };
  } catch {
    return { result: first, report: firstReport, attempts: 1 };
  }
}
