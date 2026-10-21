import { BadRequestException, Controller, Get, Query, ServiceUnavailableException } from "@nestjs/common";
import { curveInstruments, LruCache, curveCodes, parseCurve, summarizeCurve, type CurvePoint } from "@drishti/shared";

const TTL_MS = 10_000;
const SCAN_URL = "https://scanner.tradingview.com/global/scan";
const cache = new LruCache<{ at: number; points: CurvePoint[] }>(16);

/**
 * Futures curve for one of our instruments: the next 12 delivery months from TradingView's public scanner,
 * calendar spreads, and the curve shape. GET /curve?symbol=NYMEX:CL
 */
@Controller("curve")
export class CurveController {
  @Get()
  async curve(@Query("symbol") symbol = "NYMEX:CL") {
    const inst = curveInstruments().find((i) => i.symbol === symbol);
    if (!inst) throw new BadRequestException(`symbol must be one of ${curveInstruments().map((i) => i.symbol)}`);
    const reply = (points: CurvePoint[], at: number, stale?: boolean) => ({ instrument: inst, points, summary: summarizeCurve(points), fetchedAt: at, ...(stale ? { stale } : {}) });
    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.at < TTL_MS) return reply(hit.points, hit.at);

    const res = await fetch(SCAN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://www.tradingview.com", Referer: "https://www.tradingview.com/", "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify({ symbols: { tickers: curveCodes(inst.root, Date.now(), 12) }, columns: ["close", "volume", "expiration"] }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    const points = res?.ok ? parseCurve(await res.json().catch(() => null), Date.now()) : [];
    if (points.length === 0) {
      if (hit) return reply(hit.points, hit.at, true);
      throw new ServiceUnavailableException(`TradingView ${res?.status ?? "unreachable"}`);
    }
    cache.set(symbol, { at: Date.now(), points });
    return reply(points, Date.now());
  }
}
