import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { CHOKEPOINTS, chokepointFetcher, summarizeTransits } from "@drishti/shared";
import { serve } from "./source";

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
    const { data, fetchedAt, stale } = await serve(chokepointFetcher, { id: cp.id });
    return { chokepoint: cp, days: data.slice(-n), summary: summarizeTransits(data), fetchedAt, ...(stale ? { stale } : {}) };
  }
}
