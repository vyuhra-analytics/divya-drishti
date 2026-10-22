import { Controller, Get } from "@nestjs/common";
import { knownStatus, type DayOverride, type MarketStatus } from "@drishti/shared";
import { Db } from "./db";

const CACHE_MS = 3600_000;
const STATUS_CACHE_MS = 30_000;
let statusCache: { at: number; mcx: MarketStatus | null } | null = null;
const seenStates = new Set<string>();
/** Tests only: forget the cached status so each test starts from a cold cache. */
export const resetStatusCache = () => {
  statusCache = null;
  seenStates.clear();
};
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

  /**
   * The exchange's own MCX status from Upstox (cached 30 s). `mcx: null` = unknown (no token, or Upstox did not answer): the rules decide.
   * Every distinct status value is logged once, so a value we do not handle shows up instead of being silently ignored.
   */
  @Get("status")
  async status(): Promise<{ mcx: MarketStatus | null }> {
    if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) return { mcx: statusCache.mcx };
    const token = (await this.db.redis.get("upstox:token").catch(() => null)) || process.env.UPSTOX_ACCESS_TOKEN?.trim();
    let mcx: MarketStatus | null = null;
    if (token) {
      try {
        const res = await fetch("https://api.upstox.com/v2/market/status/MCX", {
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        const json: any = await res.json();
        const state = json?.data?.status;
        if (res.ok && typeof state === "string" && state) {
          mcx = { state, at: Date.now() };
          if (!seenStates.has(state)) {
            seenStates.add(state);
            console.log(`[market status] MCX status value seen: ${state}${knownStatus(state) ? "" : " (not handled: the session rules decide)"}`);
          }
        }
      } catch {
        mcx = null;
      }
    }
    statusCache = { at: Date.now(), mcx };
    return { mcx };
  }
}
