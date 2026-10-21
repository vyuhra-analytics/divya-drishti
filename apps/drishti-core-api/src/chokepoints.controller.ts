import { BadRequestException, Controller, Get, Query, ServiceUnavailableException } from "@nestjs/common";
import { CHOKEPOINTS, CHOKEPOINT_PORTNAME, LruCache, parseTransits, summarizeTransits, type TransitDay } from "@drishti/shared";

const TTL_MS = 3600_000; // PortWatch updates weekly, a few days behind: an hourly look is plenty
const BASE = "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query";
const cache = new LruCache<{ at: number; days: TransitDay[] }>(16);

/**
 * Daily tanker and vessel transits through the oil and gas chokepoints (IMF PortWatch, free and keyless, from ship tracking).
 * GET /chokepoints?id=hormuz&days=400 → { chokepoint, days, summary }
 */
@Controller("chokepoints")
export class ChokepointsController {
  @Get()
  async transits(@Query("id") id = "hormuz", @Query("days") daysParam?: string) {
    const cp = CHOKEPOINTS.find((c) => c.id === id);
    if (!cp) throw new BadRequestException(`id must be one of ${CHOKEPOINTS.map((c) => c.id)}`);
    const n = daysParam === undefined ? 400 : Number(daysParam);
    if (!Number.isInteger(n) || n < 30 || n > 1000) throw new BadRequestException("days must be 30–1000");

    const reply = (days: TransitDay[], at: number, stale?: boolean) => ({ chokepoint: cp, days: days.slice(-n), summary: summarizeTransits(days), fetchedAt: at, ...(stale ? { stale } : {}) });
    const hit = cache.get(cp.id);
    if (hit && Date.now() - hit.at < TTL_MS) return reply(hit.days, hit.at);

    const url = new URL(BASE);
    url.searchParams.set("where", `portname='${CHOKEPOINT_PORTNAME[cp.id]}'`); // name comes from our own table, never from the caller
    url.searchParams.set("outFields", "date,n_tanker,n_total,capacity_tanker");
    url.searchParams.set("orderByFields", "date DESC");
    url.searchParams.set("resultRecordCount", "1000"); // the service's page size; ~2.7 years, enough for a year-ago comparison
    url.searchParams.set("f", "json");
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const days = res?.ok ? parseTransits(await res.json().catch(() => null)) : [];
    if (days.length === 0) {
      if (hit) return reply(hit.days, hit.at, true); // PortWatch down: the last copy beats nothing
      throw new ServiceUnavailableException(`PortWatch ${res?.status ?? "unreachable"}`);
    }
    cache.set(cp.id, { at: Date.now(), days });
    return reply(days, Date.now());
  }
}
