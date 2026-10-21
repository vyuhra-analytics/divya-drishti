import { BadRequestException, Controller, Get, Query, ServiceUnavailableException } from "@nestjs/common";
import { JODI_COUNTRIES, parseJodi, summarizeJodi, type JodiPoint } from "@drishti/shared";

const TTL_MS = 12 * 3600_000; // JODI updates monthly: twice a day is plenty
const BASE = "https://www.jodidata.org/_resources/files/downloads/oil-data/annual-csv/primary";
let cache: { at: number; points: JodiPoint[] } | null = null;

/** JODI names the current year's file primaryyear{Y}.csv and earlier years {Y}.csv; try both so a rename does not break us. */
async function loadYear(year: number): Promise<JodiPoint[]> {
  const codes = JODI_COUNTRIES.map((c) => c.code);
  for (const name of [`${year}`, `primaryyear${year}`]) {
    const res = await fetch(`${BASE}/${name}.csv`, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (res?.ok) return parseJodi(await res.text(), codes);
  }
  return [];
}

/**
 * JODI Oil World: monthly crude production, imports, exports, refinery intake and stocks for India and a few comparators.
 * Free CSVs (the last two years, ~18 MB), parsed to a few thousand points and cached 12 h. GET /jodi?country=IN
 */
@Controller("jodi")
export class JodiController {
  @Get()
  async jodi(@Query("country") country = "IN") {
    if (!JODI_COUNTRIES.some((c) => c.code === country)) throw new BadRequestException(`country must be one of ${JODI_COUNTRIES.map((c) => c.code)}`);
    let stale = false;
    if (!cache || Date.now() - cache.at > TTL_MS) {
      const y = new Date().getUTCFullYear();
      const points = (await Promise.all([loadYear(y - 1), loadYear(y)])).flat();
      if (points.length) cache = { at: Date.now(), points };
      else if (cache) {
        stale = true; // JODI down: serve the last copy, and wait 5 minutes before re-downloading ~18 MB
        cache = { ...cache, at: Date.now() - TTL_MS + 5 * 60_000 };
      }
      else throw new ServiceUnavailableException("JODI unreachable");
    }
    return { country: JODI_COUNTRIES.find((c) => c.code === country), flows: summarizeJodi(cache!.points, country), fetchedAt: cache!.at, ...(stale ? { stale } : {}) };
  }
}
