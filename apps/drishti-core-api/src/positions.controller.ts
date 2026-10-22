import { Controller, Get, HttpException, ServiceUnavailableException } from "@nestjs/common";
import { ACCOUNT_ACCESS_HINT, classifyAccountAccess, parseUpstoxPositions, type OpenPosition } from "@drishti/shared";
import { Db } from "./db";

const CACHE_MS = 5_000;
let cache: { at: number; positions: OpenPosition[] } | null = null;

/**
 * Your open MCX positions (our four energy underlyings) from Upstox, read-only. Only used when the briefing panel's
 * "include my position" box is ticked. Never logged or stored here; the Upstox token never leaves this process.
 * GET /positions
 */
@Controller("positions")
export class PositionsController {
  constructor(private readonly db: Db) {}

  @Get()
  async positions(): Promise<{ positions: OpenPosition[]; asOf: number }> {
    if (cache && Date.now() - cache.at < CACHE_MS) return { positions: cache.positions, asOf: cache.at };
    const token = (await this.db.redis.get("upstox:token").catch(() => null)) || process.env.UPSTOX_ACCESS_TOKEN?.trim();
    if (!token) throw new ServiceUnavailableException("Upstox not connected: set UPSTOX_ACCESS_TOKEN or log in from Settings → Data feeds");
    const res = await fetch("https://api.upstox.com/v2/portfolio/short-term-positions", {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!res) throw new ServiceUnavailableException("Upstox unreachable");
    if (res.status === 401 || res.status === 403) {
      const why = classifyAccountAccess(res.status, await res.json().catch(() => null));
      throw new HttpException(ACCOUNT_ACCESS_HINT[why === "static_ip" ? "static_ip" : "token"], res.status);
    }
    if (!res.ok) throw new ServiceUnavailableException(`Upstox ${res.status}`);
    const json: any = await res.json();
    const positions = parseUpstoxPositions(Array.isArray(json?.data) ? json.data : []);
    cache = { at: Date.now(), positions };
    return { positions, asOf: cache.at };
  }
}
