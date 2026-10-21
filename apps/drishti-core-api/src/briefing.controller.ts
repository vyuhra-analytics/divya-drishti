import { BadGatewayException, BadRequestException, Body, Controller, HttpException, Post, ServiceUnavailableException } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { BRIEFING_SYSTEM, briefingPrompt, RateLimiter, SYMBOLS, type BriefingContext, type BriefingResult } from "@drishti/shared";

const MODEL = process.env.BRIEFING_MODEL?.trim() || "claude-opus-5-5";
const MAX_CONTEXT_BYTES = 40_000; // a real context is ~6 KB: anything bigger isn't ours
const CACHE_MS = 5 * 60_000;
const limiter = new RateLimiter(20, 3600_000); // calls per hour, all symbols: the spend ceiling

const Point = z.object({ point: z.string(), evidence: z.string() });
const Briefing = z.object({
  bias: z.enum(["bullish", "bearish", "neutral"]),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  bull: z.array(Point),
  bear: z.array(Point),
  watch: z.array(z.string()),
  data_gaps: z.array(z.string()),
});

const cache = new Map<string, { at: number; body: BriefingResponse }>();
let client: Anthropic | null = null;

export interface BriefingResponse {
  result: BriefingResult;
  model: string;
  asOf: string;
  generatedAt: number;
  usage: { input: number; output: number };
  cached: boolean;
}

/**
 * AI briefing for one instrument: bull case, bear case and a bias from the facts the web app collected
 * (quote, indicators, headlines, scheduled releases). One model call per request, cached 5 min per symbol, at most
 * 20 per hour. The key stays here (ANTHROPIC_API_KEY, or an `ant auth login` profile); it is never sent to the browser.
 * POST /briefing { context: BriefingContext }
 */
@Controller("briefing")
export class BriefingController {
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
      client ??= new Anthropic(); // resolves ANTHROPIC_API_KEY / OAuth profile itself
      const res = await client.messages.parse({
        model: MODEL,
        max_tokens: 6000,
        system: BRIEFING_SYSTEM,
        messages: [{ role: "user", content: prompt }],
        output_config: { effort: "medium", format: zodOutputFormat(Briefing) },
      });
      if (res.stop_reason === "refusal") throw new BadGatewayException("The model declined to write this briefing.");
      const out = res.parsed_output;
      if (!out) throw new BadGatewayException("The model's answer couldn't be read. Try again.");
      const cap = <T>(a: T[]) => a.slice(0, 6);
      const result: BriefingResult = { ...out, bull: cap(out.bull), bear: cap(out.bear), watch: cap(out.watch), data_gaps: cap(out.data_gaps) };
      const response: BriefingResponse = {
        result,
        model: res.model,
        asOf: ctx.asOf,
        generatedAt: Date.now(),
        usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
        cached: false,
      };
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
