import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { JODI_COUNTRIES, jodiFetcher, summarizeJodi } from "@drishti/shared";
import { serve } from "./source";

/**
 * JODI Oil World: monthly crude production, imports, exports, refinery intake and stocks for India and a few comparators.
 * Free CSVs (the last two years, ~18 MB), parsed to a few thousand points and cached 12 h. GET /jodi?country=IN
 */
@Controller("jodi")
export class JodiController {
  @Get()
  async jodi(@Query("country") country = "IN") {
    if (!JODI_COUNTRIES.some((c) => c.code === country)) throw new BadRequestException(`country must be one of ${JODI_COUNTRIES.map((c) => c.code)}`);
    const { data, fetchedAt, stale } = await serve(jodiFetcher, {});
    return { country: JODI_COUNTRIES.find((c) => c.code === country), flows: summarizeJodi(data, country), fetchedAt, ...(stale ? { stale } : {}) };
  }
}
