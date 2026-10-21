import { Controller, Get } from "@nestjs/common";
import type { DayOverride } from "@drishti/shared";
import { Db } from "./db";

const CACHE_MS = 3600_000;
let cache: { at: number; day: string; mcx: DayOverride | null } | null = null;

const istDate = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);

/**
 * Today's official MCX session from Upstox (holidays and special sessions included), for the status bar.
 * `mcx: null` = unknown (no Upstox token / API down): the web app falls back to the weekday rule in sessions.ts.
 */
@Controller("market")
export class SessionsController {
  constructor(private readonly db: Db) {}

  @Get("sessions")
  async sessions(): Promise<{ date: string; mcx: DayOverride | null }> {
    const day = istDate(Date.now());
    if (cache && cache.day === day && Date.now() - cache.at < CACHE_MS) return { date: day, mcx: cache.mcx };
    const token = (await this.db.redis.get("upstox:token").catch(() => null)) || process.env.UPSTOX_ACCESS_TOKEN?.trim();
    let mcx: DayOverride | null = null;
    if (token) {
      try {
        const res = await fetch(`https://api.upstox.com/v2/market/timings/${day}`, {
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        const json: any = await res.json();
        if (res.ok && Array.isArray(json?.data)) {
          const row = json.data.find((r: any) => r.exchange === "MCX");
          // timings list only the exchanges trading that day: no MCX row on a trading day for others = MCX holiday
          mcx = row ? { start: row.start_time, end: row.end_time } : json.data.length ? "closed" : null;
        }
      } catch {
        mcx = null;
      }
    }
    cache = { at: Date.now(), day, mcx };
    return { date: day, mcx };
  }
}
