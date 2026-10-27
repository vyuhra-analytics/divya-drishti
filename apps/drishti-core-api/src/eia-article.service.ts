import { Injectable } from "@nestjs/common";
import { analyzeReport, buildArticle, buildFacts, checkArticle, instrument, LruCache, REACTION_INSTRUMENTS, releaseMicrostructure, releaseReaction, type Article, type ArticleCheck, type Bar, type EiaReportCode, type FlowRow, type ReleaseFacts, type SeriesContext } from "@drishti/shared";
import { Db } from "./db";
import { EiaHistoryService } from "./eia-history.service";
import { EiaReportService } from "./eia-report.service";
import { upstoxHistory, yahooHistory } from "./history";
import type { StoredReport } from "./eia-report.store";

const FACTS_TTL_MS = 30_000; // the panel asks again every minute; one gather per half minute is plenty
const FEED_BEFORE_MS = 6 * 60_000;
const FEED_AFTER_MS = 16 * 60_000;

/** Where the facts come from outside the report itself. The live ones are the default; tests pass fakes. */
export interface ArticleSources {
  /** one-minute candles of an instrument, oldest first (empty when none can be had) */
  bars(symbol: string): Promise<Bar[]>;
  /** recorded feed rows of one contract in a window, oldest first */
  feed(key: string, from: number, to: number): Promise<FlowRow[]>;
  /** the context of the series a report cites, as of its week */
  contexts(report: EiaReportCode, weekEnding: string): Promise<Record<string, SeriesContext>>;
}

export interface WrittenArticle {
  id: string;
  source: string;
  at: number;
  article: Article;
  grounding: ArticleCheck | null;
}

export interface ArticleResponse {
  report: EiaReportCode;
  weekEnding: string;
  /** the facts every figure in either article is checked against */
  facts: ReleaseFacts;
  template: { article: Article; check: ArticleCheck };
  /** the newest article Claude wrote over MCP for this release, with the verdict per paragraph; null when none */
  written: WrittenArticle | null;
}

/**
 * Gathers everything a release article needs: the stored report with its analysis, the weekly history context, the forecast, and the market reaction
 * (candles around the official release time, plus our own recording of the feed for the MCX contracts), and turns it into `ReleaseFacts`.
 * A part that cannot be had is left out of the facts, never guessed.
 */
@Injectable()
export class EiaArticleService {
  /** replaceable for tests */
  sources: ArticleSources;
  private readonly cache = new LruCache<{ at: number; facts: ReleaseFacts }>(16);

  constructor(
    private readonly db: Db,
    private readonly reports: EiaReportService,
    private readonly history: EiaHistoryService,
  ) {
    this.sources = {
      bars: async (symbol) => {
        const inst = instrument(symbol);
        if (!inst) return [];
        const bars = inst.exchange === "MCX" ? await upstoxHistory(inst, "1m", this.db.redis) : await yahooHistory(inst, "1m");
        return bars ?? [];
      },
      feed: async (key, from, to) =>
        (await this.db.sql`
          SELECT extract(epoch FROM time)::float8 * 1000 AS time, price, volume, bid, ask, bid_qty AS "bidQty", ask_qty AS "askQty", depth
          FROM feed_quotes WHERE key = ${key} AND time >= ${new Date(from).toISOString()} AND time < ${new Date(to).toISOString()} ORDER BY time LIMIT 100000`.catch(() => [])) as FlowRow[],
      contexts: (report, weekEnding) => this.history.contexts(report, weekEnding).catch(() => ({})),
    };
  }

  /** The newest stored report of the kind (or of a given week) with its facts; undefined when none is stored. */
  async facts(report: EiaReportCode, week?: string, forecastOverride?: number): Promise<{ stored: StoredReport; facts: ReleaseFacts } | undefined> {
    const stored = await this.reports.store.latest(report, week);
    if (!stored) return undefined;
    const cacheKey = `${report}|${stored.weekEnding}|${forecastOverride ?? ""}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < FACTS_TTL_MS) return { stored, facts: hit.facts };

    let forecast = forecastOverride === undefined ? undefined : { value: forecastOverride, source: "typed in" };
    if (!forecast) forecast = await this.reports.store.forecastFor(stored.eventId).catch(() => undefined);
    const analysis = analyzeReport({ report, periodEnd: Date.parse(stored.weekEnding), releasedAt: stored.officialReleaseAt, rows: stored.rows }, { forecast: forecast?.value });
    if (!analysis) return undefined;
    const releaseAt = stored.officialReleaseAt ?? stored.scheduledAt;

    const reactions: Record<string, { label: string; decimals: number; reaction?: ReturnType<typeof releaseReaction>; micro?: ReturnType<typeof releaseMicrostructure> }> = {};
    if (releaseAt < Date.now()) {
      await Promise.all(
        REACTION_INSTRUMENTS[report].map(async (i) => {
          const bars = await this.sources.bars(i.symbol).catch(() => [] as Bar[]);
          const reaction = releaseReaction(i.symbol, bars, releaseAt);
          if (!reaction) {
            reactions[i.key] = { label: i.label, decimals: i.decimals }; // kept as missing, so the article can say why there is nothing
            return;
          }
          // the recorded feed exists for the MCX contracts only (the NYMEX feeds are delayed and not recorded)
          const micro = i.symbol.startsWith("MCX:") ? releaseMicrostructure(await this.sources.feed(i.symbol, releaseAt - FEED_BEFORE_MS, releaseAt + FEED_AFTER_MS).catch(() => []), releaseAt) : undefined;
          reactions[i.key] = { label: i.label, decimals: i.decimals, reaction, micro };
        }),
      );
    }

    const built = buildFacts({
      report: { report, periodEnd: Date.parse(stored.weekEnding), rows: stored.rows },
      analysis,
      context: await this.sources.contexts(report, stored.weekEnding),
      forecast,
      releasedAt: stored.officialReleaseAt,
      storedAt: stored.firstStoredAt,
      backfilled: stored.backfilled,
      reactions,
    });
    this.cache.set(cacheKey, { at: Date.now(), facts: built });
    return { stored, facts: built };
  }

  /** Facts, our own article with its check, and the newest article Claude wrote. */
  async article(report: EiaReportCode, week?: string, forecastOverride?: number): Promise<ArticleResponse | undefined> {
    const got = await this.facts(report, week, forecastOverride);
    if (!got) return undefined;
    const article = buildArticle(got.facts);
    return { report, weekEnding: got.stored.weekEnding, facts: got.facts, template: { article, check: checkArticle(article, got.facts) }, written: await this.written(report, got.stored.weekEnding) };
  }

  async written(report: EiaReportCode, weekEnding: string): Promise<WrittenArticle | null> {
    const rows = (await this.db.sql`
      SELECT id, source, extract(epoch FROM at)::float8 * 1000 AS at, article, grounding FROM eia_articles
      WHERE report = ${report} AND week_ending = ${weekEnding}::date AND source = 'claude-mcp' ORDER BY at DESC LIMIT 1`.catch(() => [])) as { id: string; source: string; at: number; article: Article; grounding: ArticleCheck | null }[];
    return rows[0] ? { id: rows[0].id, source: rows[0].source, at: Math.round(Number(rows[0].at)), article: rows[0].article, grounding: rows[0].grounding } : null;
  }
}
