import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { curveFetcher, curveInstruments, summarizeCurve } from "@drishti/shared";
import { serve } from "./source";

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
    const { data, fetchedAt, stale } = await serve(curveFetcher, { symbol });
    return { instrument: inst, points: data, summary: summarizeCurve(data), fetchedAt, ...(stale ? { stale } : {}) };
  }
}
