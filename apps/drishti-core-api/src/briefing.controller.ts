import { BadGatewayException, BadRequestException, Body, Controller, HttpException, Post, ServiceUnavailableException } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { BRIEFING_SYSTEM, briefingPrompt, LruCache, RateLimiter, SYMBOLS, writeGrounded, type BriefingContext, type BriefingResult, type GroundingReport } from "@drishti/shared";

const MODEL = process.env.BRIEFING_MODEL?.trim() || "claude-opus-5-5";
const MAX_CONTEXT_BYTES = 40_000; // a real context is ~6 KB: anything bigger isn't ours
const CACHE_MS = 5 * 60_000;
const limiter = new RateLimiter(20, 3600_000); // calls per hour, all symbols: the spend ceiling

const Point = z.object({ point: z.string(), evidence: z.string(), cites: z.array(z.object({ field: z.string(), value: z.string() })) }); // cites are checked against the data by code (shared grounding.ts)
const Briefing = z.object({
  bias: z.enum(["bullish", "bearish", "neutral"]),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  bull: z.array(Point),
  bear: z.array(Point),
  watch: z.array(z.string()),
  data_gaps: z.array(z.string()),
});

const cache = new LruCache<{ at: number; body: BriefingResponse }>(32); // keyed by a validated symbol, capped anyway: every cache keyed by input is
let client: Anthropic | null = null;

export interface BriefingResponse {
  result: BriefingResult;
  model: string;
  asOf: string;
  generatedAt: number;
  /** tokens over every call made for this briefing */
  usage: { input: number; output: number };
  /** how each point held up against the data we gave the model, checked by code */
  grounding: GroundingReport;
  /** model calls used: 2 when the first answer cited something that did not match the data */
  attempts: number;
  cached: boolean;
}

/** One model call. Replaceable so the retry and error handling can be tested without the AI service. */
export type Complete = (messages: Anthropic.MessageParam[]) => Promise<{ out: z.infer<typeof Briefing> | null; model: string; usage: { input: number; output: number }; refused: boolean }>;

const callModel: Complete = async (messages) => {
  client ??= new Anthropic(); // resolves ANTHROPIC_API_KEY / OAuth profile itself
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 6000,
    system: BRIEFING_SYSTEM,
    messages,
    output_config: { effort: "medium", format: zodOutputFormat(Briefing) },
  });
  return { out: res.parsed_output, model: res.model, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens }, refused: res.stop_reason === "refusal" };
};

/**
 * AI briefing for one instrument: bull case, bear case and a bias from the facts the web app collected
 * (quote, indicators, headlines, scheduled releases). One model call per request, cached 5 min per symbol, at most
 * 20 per hour. The key stays here (ANTHROPIC_API_KEY, or an `ant auth login` profile); it is never sent to the browser.
 * POST /briefing { context: BriefingContext }
 */
@Controller("briefing")
export class BriefingController {
  /** the model call; tests replace it */
  complete: Complete = callModel;

  @Post()
  async brief(@Body() body: { context?: BriefingContext }): Promise<BriefingResponse> {
    const ctx = body?.context;
    if (!ctx || typeof ctx !== "object" || !SYMBOLS.includes(ctx.symbol)) throw new BadRequestException("context.symbol must be one of our instruments");
    const prompt = briefingPrompt(ctx);
    if (Buffer.byteLength(prompt) > MAX_CONTEXT_BYTES) throw new BadRequestException("context too large");

    const hit = cache.get(ctx.symbol);
    if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.body, cached: true };
    if (!limiter.take("briefing")) throw new HttpException("Briefing limit reached (20 per hour). Try again later.", 429);

    try {
      const usage = { input: 0, output: 0 };
      let model = MODEL;
      let previous: z.infer<typeof Briefing> | undefined;
      const cap = <T>(a: T[]) => a.slice(0, 6);
      // one call, or a second one when the first cited something that does not match the data: it is told exactly what was wrong (see shared writeGrounded)
      const ask = async (feedback?: string): Promise<BriefingResult> => {
        if (feedback && !limiter.take("briefing")) throw new Error("hourly limit reached: keep the first answer");
        const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
        if (feedback && previous) messages.push({ role: "assistant", content: JSON.stringify(previous) }, { role: "user", content: feedback });
        const res = await this.complete(messages);
        usage.input += res.usage.input;
        usage.output += res.usage.output;
        model = res.model;
        if (res.refused) throw new BadGatewayException("The model declined to write this briefing. The Recap panel gives a no-AI summary of the same data.");
        if (!res.out) throw new BadGatewayException("The model's answer couldn't be read. Try again.");
        previous = res.out;
        return { ...res.out, bull: cap(res.out.bull), bear: cap(res.out.bear), watch: cap(res.out.watch), data_gaps: cap(res.out.data_gaps) };
      };
      const grounded = await writeGrounded(ctx, ask);
      const response: BriefingResponse = { result: grounded.result, model, asOf: ctx.asOf, generatedAt: Date.now(), usage, grounding: grounded.report, attempts: grounded.attempts, cached: false };
      cache.set(ctx.symbol, { at: Date.now(), body: response });
      return response;
    } catch (e) {
      if (e instanceof HttpException) throw e;
      if (e instanceof Anthropic.AuthenticationError || (e instanceof Error && /authentication|api ?key|auth ?token|credentials/i.test(e.message) && !(e instanceof Anthropic.APIError))) {
        client = null;
        throw new ServiceUnavailableException("Set ANTHROPIC_API_KEY in .env (or run `ant auth login`) to enable AI briefings");
      }
      if (e instanceof Anthropic.RateLimitError) throw new HttpException("The AI service is rate limiting us. Try again in a minute.", 429);
      if (e instanceof Anthropic.APIError) throw new BadGatewayException(`AI service error (${e.status})`);
      throw new BadGatewayException("Briefing failed");
    }
  }
}
