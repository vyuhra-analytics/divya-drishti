import { BadRequestException, Controller, Get, GoneException, HttpException, Post, Body, Query, ServiceUnavailableException } from "@nestjs/common";
import { AGENT_BRIEFING_INSTRUCTIONS, BRIEFING_SYSTEM, checkBriefing, citableFields, instrument, LruCache, parseSubmission, RateLimiter, TIMEFRAMES, type BriefingContext, type BriefingResult, type GroundingReport } from "@drishti/shared";
import { Db } from "./db";
import { gatherServerContext, liveSources, type Sources } from "./briefing-facts";

const CONTEXT_TTL_MS = 30 * 60_000; // an agent may take a while to write; after this it must ask for fresh facts
const submitLimiter = new RateLimiter(12, 3600_000); // submissions an hour: a research note, not a feed
const contexts = new LruCache<{ at: number; ctx: BriefingContext }>(64);
const STREAM = `http://127.0.0.1:${process.env.STREAM_PORT ?? 3002}`;

export interface SubmittedBriefing {
  id: string;
  symbol: string;
  at: number;
  source: string;
  priceThen: number;
  result: BriefingResult;
  grounding: GroundingReport;
}

/**
 * Briefings written by an outside agent (Claude over MCP) instead of by our own model call, so they cost no API spend.
 *  GET  /briefing/context?symbol&tf  the facts, the list of citable fields and the rules, under a context id
 *  POST /briefing/submit             the agent's briefing: its cited figures are checked against that context, it is stored and shown in the
 *                                    Briefing panel with a verdict per point, and the verdicts are returned so the agent can correct itself
 *  GET  /briefing/submitted          what has been submitted, newest first (the panel reads this)
 */
@Controller("briefing")
export class BriefingFactsController {
  constructor(private readonly db: Db) {}
  /** where the facts come from; tests replace it */
  sources: Sources = liveSources;
  /** tells the stream so open browsers show a notice; tests replace it */
  announce: (b: { id: string; symbol: string; bias: string; verified: number; total: number; wrong: number }) => Promise<void> = (b) =>
    fetch(`${STREAM}/briefings/announce`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(3000) }).then(() => undefined, () => undefined);

  @Get("context")
  async context(@Query("symbol") symbol?: string, @Query("tf") tfParam?: string) {
    if (!symbol || !instrument(symbol)) throw new BadRequestException("symbol must be one of our instruments");
    const tf = tfParam ?? "5m";
    if (!(tf in TIMEFRAMES)) throw new BadRequestException(`tf must be one of ${Object.keys(TIMEFRAMES)}`);
    let context: BriefingContext;
    try {
      context = await gatherServerContext(symbol, tf, this.sources);
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
    const contextId = `ctx-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    contexts.set(contextId, { at: Date.now(), ctx: context });
    return { context_id: contextId, expires_in_minutes: CONTEXT_TTL_MS / 60_000, instructions: AGENT_BRIEFING_INSTRUCTIONS, rules: BRIEFING_SYSTEM, citable: citableFields(context), context };
  }

  @Post("submit")
  async submit(@Body() body: unknown) {
    const parsed = parseSubmission(body);
    if ("error" in parsed) throw new BadRequestException(parsed.error);
    const { symbol, contextId, result } = parsed.submission;
    if (!instrument(symbol)) throw new BadRequestException("symbol must be one of our instruments");
    const held = contexts.get(contextId);
    if (!held || Date.now() - held.at > CONTEXT_TTL_MS) throw new GoneException("That context has expired or is unknown: call get_briefing_context again and write from the new facts.");
    if (held.ctx.symbol !== symbol) throw new BadRequestException(`That context is for ${held.ctx.symbol}, not ${symbol}.`);
    if (!submitLimiter.take("submit")) throw new HttpException("Briefing submissions are limited to 12 an hour.", 429);

    const grounding = checkBriefing(result, held.ctx); // against the facts the agent was given, not against whatever the market is doing now
    const id = `bm-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try {
      await this.db.sql`INSERT INTO briefings (id, symbol, source, price_then, result, grounding) VALUES (${id}, ${symbol}, ${"claude-mcp"}, ${held.ctx.price}, ${JSON.stringify(result)}::text::jsonb, ${JSON.stringify(grounding)}::text::jsonb)`;
    } catch {
      throw new ServiceUnavailableException("The briefing could not be stored (is the database migrated? bun run db:migrate).");
    }
    void this.announce({ id, symbol, bias: result.bias, verified: grounding.verified, total: grounding.total, wrong: grounding.wrong });
    return {
      id,
      stored: true,
      verified: grounding.verified,
      total: grounding.total,
      wrong: grounding.wrong,
      points: grounding.points.filter((p) => p.verdict !== "verified").map((p) => ({ section: p.section, point: p.index + 1, verdict: p.verdict, issues: p.issues.map((i) => i.text) })),
      other: grounding.other.map((i) => i.text),
      next: grounding.wrong > 0 ? "Some cited figures contradict the data. Correct those points and submit again; the first submission stays on record." : "Shown in the Briefing panel.",
    };
  }

  @Get("submitted")
  async submitted(@Query("limit") limit?: string): Promise<SubmittedBriefing[]> {
    const n = Math.min(Math.max(Number(limit ?? 10) || 10, 1), 30);
    const rows = (await this.db.sql`SELECT id, symbol, extract(epoch FROM at)::float8 * 1000 AS at, source, price_then, result, grounding FROM briefings ORDER BY at DESC LIMIT ${n}`.catch(() => [])) as {
      id: string; symbol: string; at: number; source: string; price_then: number; result: BriefingResult; grounding: GroundingReport;
    }[];
    return rows.map((r) => ({ id: r.id, symbol: r.symbol, at: Math.round(Number(r.at)), source: r.source, priceThen: r.price_then, result: r.result, grounding: r.grounding }));
  }
}
