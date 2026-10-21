import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { energyReleases, mcxHolidays, mergeForexFactory, type CalEvent, type FFRow, type HolidayRow } from "@drishti/shared";
import { Db } from "./db";

const TTL_MS = 15 * 60_000;
const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
let cache: { at: number; days: number; events: CalEvent[] } | null = null;

/**
 * Energy calendar: weekly US releases (API, EIA oil and gas, Baker Hughes) from a fixed schedule, enriched with
 * Forex Factory's free weekly feed (forecast/previous, USD high-impact macro, OPEC), plus MCX holidays from Upstox
 * when a token is set. Each source is optional: one being down just thins the list. Cached 15 min.
 * GET /calendar?days=14
 */
@Controller("calendar")
export class CalendarController {
  constructor(private readonly db: Db) {}

  @Get()
  async events(@Query("days") daysParam?: string): Promise<CalEvent[]> {
    const days = daysParam === undefined ? 14 : Number(daysParam);
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new BadRequestException("days must be 1–60");
    if (cache && cache.days === days && Date.now() - cache.at < TTL_MS) return cache.events;

    const from = Date.now() - 6 * 3600_000; // keep today's earlier releases visible
    const to = Date.now() + days * 86_400_000;
    const [ff, holidays] = await Promise.all([this.forexFactory(), this.upstoxHolidays()]);
    const events = [...mergeForexFactory(energyReleases(from, to), ff, from, to), ...mcxHolidays(holidays, from, to)].sort((a, b) => a.at - b.at);
    cache = { at: Date.now(), days, events };
    return events;
  }

  private async forexFactory(): Promise<FFRow[]> {
    try {
      const res = await fetch(FF_URL, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10_000) });
      return res.ok ? ((await res.json()) as FFRow[]) : [];
    } catch {
      return [];
    }
  }

  private async upstoxHolidays(): Promise<HolidayRow[]> {
    const token = (await this.db.redis.get("upstox:token").catch(() => null)) || process.env.UPSTOX_ACCESS_TOKEN?.trim();
    if (!token) return [];
    try {
      const res = await fetch("https://api.upstox.com/v2/market/holidays", {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      const json: any = await res.json();
      return res.ok && Array.isArray(json?.data) ? json.data : [];
    } catch {
      return [];
    }
  }
}
