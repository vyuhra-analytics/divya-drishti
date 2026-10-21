import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { NEWS_TAGS, newsFromRow, type NewsItem, type NewsRow } from "@drishti/shared";
import { Db } from "./db";

/**
 * News archive (written by drishti-core-stream): older stories for the News panel's "Load older".
 * GET /news?tags=crude,oil&before=<epoch ms>&limit=100 → newest first, strictly older than `before`.
 */
@Controller("news")
export class NewsController {
  constructor(private readonly db: Db) {}

  @Get()
  async list(@Query("tags") tags?: string, @Query("before") before?: string, @Query("limit") limit?: string): Promise<NewsItem[]> {
    const wanted = (tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    if (wanted.some((t) => !(NEWS_TAGS as string[]).includes(t))) throw new BadRequestException(`tags must be from ${NEWS_TAGS}`);
    const beforeMs = before ? Number(before) : Date.now();
    if (!Number.isFinite(beforeMs)) throw new BadRequestException("before must be epoch milliseconds");
    const n = Math.min(Math.max(Number(limit ?? 100) || 100, 1), 200);

    const rows = await this.db.sql<NewsRow[]>`
      SELECT id, title, url, source, published_at, tags, copies FROM news
      WHERE published_at < ${new Date(beforeMs)}
        AND (${wanted.length === 0} OR tags && ${`{${wanted.join(",")}}`}::text[]) -- tags validated against NEWS_TAGS above
      ORDER BY published_at DESC
      LIMIT ${n}`.catch(() => [] as NewsRow[]); // no database: no archive, not an error
    return rows.map(newsFromRow);
  }
}
