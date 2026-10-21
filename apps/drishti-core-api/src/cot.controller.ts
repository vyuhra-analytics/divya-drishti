import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { COT_MARKETS, cotFetcher } from "@drishti/shared";
import { serve } from "./source";

/**
 * CFTC Commitments of Traders for WTI, Brent, RBOB and Henry Hub: managed money (speculators), producers, swap dealers and
 * others, long and short, weekly. Free and keyless (Socrata); positions as of Tuesday, published the Friday after.
 * GET /cot?market=wti&weeks=156
 */
@Controller("cot")
export class CotController {
  @Get()
  async cot(@Query("market") market = "wti", @Query("weeks") weeksParam?: string) {
    const m = COT_MARKETS.find((x) => x.id === market);
    if (!m) throw new BadRequestException(`market must be one of ${COT_MARKETS.map((x) => x.id)}`);
    const weeks = weeksParam === undefined ? 156 : Number(weeksParam);
    if (!Number.isInteger(weeks) || weeks < 10 || weeks > 520) throw new BadRequestException("weeks must be 10–520");
    const { data, fetchedAt, stale } = await serve(cotFetcher, { market: m.id, weeks });
    return { market: { id: m.id, code: m.code, name: m.name }, rows: data, fetchedAt, ...(stale ? { stale } : {}) };
  }
}
