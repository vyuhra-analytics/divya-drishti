// A briefing written by an outside agent (Claude over MCP) and handed back to the app. Strict on shape and length, because it is
// untrusted input; the facts in it are then checked against the context the agent was given (grounding.ts).
import type { Bias, BriefingPoint, BriefingResult } from "./briefing";

export interface BriefingSubmission {
  symbol: string;
  /** the id of the context the agent was given by `get_briefing_context`: its figures are what the briefing is checked against */
  contextId: string;
  result: BriefingResult;
}

/** What the agent is told alongside the context, so it knows the contract. */
export const AGENT_BRIEFING_INSTRUCTIONS = `You are writing a research briefing for the Divya Drishti app. The "context" holds the facts; "citable" lists every fact you may cite, by field.
1. Write the briefing from those facts only, following the rules in "rules".
2. Then call submit_briefing with the same context_id, your bias, confidence, summary, bull points, bear points, watch items and data gaps.
3. Each bull and bear point needs "evidence" (a short plain quote) and "cites": one to three {field, value} pairs copied exactly from "citable". The app checks them against the data and shows each point as checked, contradicted or unchecked. submit_briefing returns the verdict per point: if any point is marked wrong, correct it and submit again.
4. Do not write any number that is not in "citable", and do not give trade advice.`;

const BIAS: Bias[] = ["bullish", "bearish", "neutral"];
const CONFIDENCE = ["low", "medium", "high"] as const;
const MAX_POINTS = 6;

const str = (v: unknown, min: number, max: number): string | undefined => (typeof v === "string" && v.trim().length >= min && v.length <= max ? v.trim() : undefined);

function parsePoint(v: unknown, where: string): BriefingPoint | { error: string } {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const point = str(o.point, 1, 240);
  const evidence = str(o.evidence, 1, 160);
  if (!point) return { error: `${where}: point must be 1 to 240 characters` };
  if (!evidence) return { error: `${where}: evidence must be 1 to 160 characters` };
  const raw = Array.isArray(o.cites) ? o.cites : [];
  if (raw.length > 3) return { error: `${where}: at most 3 cites` };
  const cites = [];
  for (const c of raw) {
    const field = str((c as Record<string, unknown>)?.field, 1, 80);
    const value = str((c as Record<string, unknown>)?.value, 1, 200);
    if (!field || !value) return { error: `${where}: each cite needs a field and a value` };
    cites.push({ field, value });
  }
  return { point, evidence, cites };
}

function parseList(v: unknown, where: string, max: number): string[] | { error: string } {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_POINTS) return { error: `${where} must be a list of at most ${MAX_POINTS}` };
  const out: string[] = [];
  for (const s of v) {
    const t = str(s, 1, max);
    if (!t) return { error: `${where}: each item must be 1 to ${max} characters` };
    out.push(t);
  }
  return out;
}

/** Validate what an agent submitted. Anything over a length cap, or of the wrong type, is refused with the reason. */
export function parseSubmission(body: unknown): { submission: BriefingSubmission } | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const symbol = str(b.symbol, 1, 40);
  const contextId = str(b.context_id, 1, 64);
  if (!symbol) return { error: "symbol is required" };
  if (!contextId) return { error: "context_id is required: call get_briefing_context first and pass its context_id" };
  if (!BIAS.includes(b.bias as Bias)) return { error: "bias must be bullish, bearish or neutral" };
  if (!CONFIDENCE.includes(b.confidence as (typeof CONFIDENCE)[number])) return { error: "confidence must be low, medium or high" };
  const summary = str(b.summary, 1, 600);
  if (!summary) return { error: "summary must be 1 to 600 characters" };

  const sections: Record<"bull" | "bear", BriefingPoint[]> = { bull: [], bear: [] };
  for (const key of ["bull", "bear"] as const) {
    const raw = b[key];
    if (!Array.isArray(raw) || raw.length > MAX_POINTS) return { error: `${key} must be a list of at most ${MAX_POINTS} points` };
    for (const [i, p] of raw.entries()) {
      const r = parsePoint(p, `${key} point ${i + 1}`);
      if ("error" in r) return r;
      sections[key].push(r);
    }
  }
  const watch = parseList(b.watch, "watch", 200);
  if ("error" in watch) return watch;
  const gaps = parseList(b.data_gaps, "data_gaps", 200);
  if ("error" in gaps) return gaps;

  return { submission: { symbol, contextId, result: { bias: b.bias as Bias, confidence: b.confidence as BriefingResult["confidence"], summary, bull: sections.bull, bear: sections.bear, watch, data_gaps: gaps } } };
}
