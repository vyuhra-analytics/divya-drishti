import { BadRequestException, Body, Controller, Get, GoneException, HttpException, NotFoundException, Post, Query, ServiceUnavailableException } from "@nestjs/common";
import { AGENT_ARTICLE_INSTRUCTIONS, articleMarkdown, checkArticle, citableFacts, LruCache, parseArticleSubmission, RateLimiter, type EiaReportCode, type ReleaseFacts } from "@drishti/shared";
import { Db } from "./db";
import { EiaArticleService } from "./eia-article.service";
import { EiaHistoryService } from "./eia-history.service";

const CONTEXT_TTL_MS = 30 * 60_000; // an agent may take a while to write; after this it must ask for fresh facts
const submitLimiter = new RateLimiter(12, 3600_000); // submissions an hour: a research note, not a feed
const contexts = new LruCache<{ at: number; facts: ReleaseFacts }>(32);

const checkReport = (report?: string): EiaReportCode => {
  if (report !== "WPSR" && report !== "WNGSR") throw new BadRequestException("report must be WPSR or WNGSR");
  return report;
};
const checkWeek = (week?: string) => {
  if (week !== undefined && week !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new BadRequestException("week must be YYYY-MM-DD");
  return week || undefined;
};

/**
 * Release articles for the two EIA reports.
 *   GET  /eia-report/article?report&week&forecast   the facts, the article our own rules write from them (every paragraph checked), and the newest
 *                                                   article Claude wrote over MCP with its verdict per paragraph
 *   GET  /eia-report/context?report&week            for an agent: the facts, `citable` (every figure by path), the rules and a context id
 *   POST /eia-report/article/submit                 the agent's article: its cited figures are checked against that context, it is stored, and the
 *                                                   verdict per paragraph is returned so the agent can correct itself
 *   GET  /eia-report/history/status                 how much weekly history is loaded, and how many weeks are stored as published
 *   GET  /eia-report/crosscheck?report&weeks        published against EIA's API for the newest stored weeks: the revisions
 */
@Controller("eia-report")
export class EiaArticleController {
  constructor(
    private readonly articles: EiaArticleService,
    private readonly history: EiaHistoryService,
    private readonly db: Db,
  ) {}

  @Get("article")
  async article(@Query("report") report?: string, @Query("week") week?: string, @Query("forecast") forecastParam?: string) {
    const forecast = forecastParam === undefined || forecastParam === "" ? undefined : Number(forecastParam);
    if (forecast !== undefined && (!Number.isFinite(forecast) || Math.abs(forecast) > 10_000)) throw new BadRequestException("forecast must be a number");
    const r = await this.articles.article(checkReport(report), checkWeek(week), forecast);
    if (!r) throw new NotFoundException("no stored report yet: the watcher stores one at the next release");
    return { ...r, template: { ...r.template, markdown: articleMarkdown(r.template.article, { source: "Written by the app's own rules from EIA's tables", check: r.template.check }) }, written: r.written && { ...r.written, markdown: articleMarkdown(r.written.article, { source: "Written by Claude from the app's facts, figures checked by code", check: r.written.grounding ?? undefined }) } };
  }

  @Get("context")
  async context(@Query("report") report?: string, @Query("week") week?: string) {
    const got = await this.articles.facts(checkReport(report), checkWeek(week));
    if (!got) throw new NotFoundException("no stored report yet: the watcher stores one at the next release");
    const contextId = `ectx-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    contexts.set(contextId, { at: Date.now(), facts: got.facts });
    return { context_id: contextId, expires_in_minutes: CONTEXT_TTL_MS / 60_000, instructions: AGENT_ARTICLE_INSTRUCTIONS, citable: citableFacts(got.facts), facts: got.facts };
  }

  @Post("article/submit")
  async submit(@Body() body: unknown) {
    const parsed = parseArticleSubmission(body);
    if ("error" in parsed) throw new BadRequestException(parsed.error);
    const { report, contextId, article } = parsed.submission;
    const held = contexts.get(contextId);
    if (!held || Date.now() - held.at > CONTEXT_TTL_MS) throw new GoneException("That context has expired or is unknown: call get_eia_release_context again and write from the new facts.");
    if (held.facts.report !== report) throw new BadRequestException(`That context is for ${held.facts.report}, not ${report}.`);
    if (!submitLimiter.take("submit")) throw new HttpException("Article submissions are limited to 12 an hour.", 429);

    const grounding = checkArticle(article, held.facts); // against the facts the agent was given, not against whatever the data says now
    const id = `ea-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try {
      await this.db.sql`INSERT INTO eia_articles (id, report, week_ending, source, article, grounding) VALUES (${id}, ${report}, ${held.facts.weekEnding}::date, ${"claude-mcp"}, ${JSON.stringify(article)}::text::jsonb, ${JSON.stringify(grounding)}::text::jsonb)`;
    } catch {
      throw new ServiceUnavailableException("The article could not be stored (is the database migrated? bun run db:migrate).");
    }
    const problems = grounding.paragraphs.filter((p) => p.verdict !== "verified");
    return {
      id,
      stored: true,
      verified: grounding.verified,
      total: grounding.total,
      wrong: grounding.wrong,
      paragraphs: problems.map((p) => ({ section: article.sections[p.section].heading, paragraph: p.index + 1, verdict: p.verdict, issues: p.issues.map((i) => i.text) })),
      other: grounding.other.map((i) => i.text),
      next: grounding.wrong > 0 ? "Some cited figures contradict the facts. Correct those paragraphs and submit again; the first submission stays on record." : "Shown in the EIA Report panel, Article tab.",
    };
  }

  @Get("history/status")
  historyStatus() {
    return this.history.status();
  }

  /** Published against EIA's API for the newest stored weeks: where they differ, the report was later revised. GET /eia-report/crosscheck?report=WPSR&weeks=26 */
  @Get("crosscheck")
  async crosscheck(@Query("report") report?: string, @Query("weeks") weeksParam?: string) {
    const weeks = weeksParam === undefined ? 26 : Number(weeksParam);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 520) throw new BadRequestException("weeks must be 1 to 520");
    return this.history.crosscheck(checkReport(report), weeks);
  }
}
