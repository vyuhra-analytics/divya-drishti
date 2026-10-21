import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { EIA_SERIES, parseEia, summarizeEia, type EiaSummary } from "@drishti/shared";

const TTL_MS = 3600_000; // weekly data (spot prices daily): an hourly look is plenty, and keeps us far under EIA's limits
const RETRY_MS = 5 * 60_000;
const LENGTH = { weekly: 320, daily: 400 } as const; // ~6 weekly years for the five-year average, ~1.5 daily years
let cache: { at: number; rows: EiaSummary[] } | null = null;

/**
 * EIA Open Data v2: US crude, Cushing, gasoline, distillate and SPR stocks, refinery utilisation, product supplied and
 * WTI / Brent / Henry Hub spot, each against last week, last year and the five-year average. Needs a free `EIA_API_KEY`
 * (eia.gov/opendata); the shared DEMO_KEY allows only ~10 calls an hour, so it is never used. GET /eia
 */
@Controller("eia")
export class EiaController {
  @Get()
  async eia() {
    const key = process.env.EIA_API_KEY?.trim();
    if (!key) throw new ServiceUnavailableException("Set EIA_API_KEY in .env (free key at https://www.eia.gov/opendata/)");
    if (cache && Date.now() - cache.at < TTL_MS) return this.reply(cache.rows, cache.at);

    const rows = await Promise.all(
      EIA_SERIES.map(async (s) => {
        const url = new URL(`https://api.eia.gov/v2/seriesid/${s.route}`);
        url.searchParams.set("api_key", key);
        url.searchParams.set("length", String(LENGTH[s.freq]));
        url.searchParams.set("sort[0][column]", "period");
        url.searchParams.set("sort[0][direction]", "desc");
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
        const points = res?.ok ? parseEia(await res.json().catch(() => null)) : [];
        return summarizeEia(s.id, points);
      }),
    );
    if (rows.every((r) => !r.latest)) {
      if (cache) {
        cache = { ...cache, at: Date.now() - TTL_MS + RETRY_MS }; // EIA down or key rejected: serve the last copy, retry in 5 minutes
        return this.reply(cache.rows, cache.at, true);
      }
      throw new ServiceUnavailableException("EIA returned no data (check EIA_API_KEY)");
    }
    cache = { at: Date.now(), rows };
    return this.reply(rows, cache.at);
  }

  private reply(rows: EiaSummary[], at: number, stale?: boolean) {
    return { series: EIA_SERIES.map((s) => ({ ...s, ...rows.find((r) => r.id === s.id)! })), fetchedAt: at, ...(stale ? { stale } : {}) };
  }
}
