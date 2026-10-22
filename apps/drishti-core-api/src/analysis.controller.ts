import { BadRequestException, Controller, Get, Query, ServiceUnavailableException } from "@nestjs/common";
import { instrument, TIMEFRAMES } from "@drishti/shared";
import { liveSources, marketStatus, recap, technicals, type Sources } from "./briefing-facts";

/**
 * Computed views of the market for agents and tools: what the indicators say, a no-AI recap, and the state of every feed. Read-only;
 * each is built from the same code and data as the panels.
 *  GET /analysis/technicals?symbol&tf   GET /analysis/recap?symbol   GET /analysis/status
 */
@Controller("analysis")
export class AnalysisController {
  /** where the facts come from; tests replace it */
  sources: Sources = liveSources;

  @Get("technicals")
  async technicals(@Query("symbol") symbol?: string, @Query("tf") tfParam?: string) {
    if (!symbol || !instrument(symbol)) throw new BadRequestException("symbol must be one of our instruments");
    const tf = tfParam ?? "5m";
    if (!(tf in TIMEFRAMES)) throw new BadRequestException(`tf must be one of ${Object.keys(TIMEFRAMES)}`);
    return technicals(symbol, tf, this.sources).catch((e: Error) => {
      throw new ServiceUnavailableException(e.message);
    });
  }

  @Get("recap")
  async recap(@Query("symbol") symbol?: string) {
    if (!symbol || !instrument(symbol)) throw new BadRequestException("symbol must be one of our instruments");
    return recap(symbol, this.sources).catch((e: Error) => {
      throw /covers the energy/.test(e.message) ? new BadRequestException(e.message) : new ServiceUnavailableException(e.message);
    });
  }

  @Get("status")
  status() {
    return marketStatus(this.sources);
  }
}
