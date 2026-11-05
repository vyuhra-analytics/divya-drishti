import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { SignalLogService } from "./signal-log.service";
import { TrendSetupService } from "./trend-setup.service";

/**
 * GET /signals?strategy=report-day|usib|trend-setup&limit=30: the logged evenings, newest first, each with the range, the candles of the window, the signal or the reason
 * there was none, and the paper trade it led to (when one carried the signal's time). Research only: nothing here places an order.
 */
@Controller("signals")
export class SignalLogController {
  constructor(
    private readonly log: SignalLogService,
    private readonly setup: TrendSetupService,
  ) {}

  /** The trend setup scanner's latest read per market (verdict and summary), while the API has run a pass. */
  @Get("trend-setup/status")
  status() {
    return Object.fromEntries(this.setup.last);
  }

  @Get()
  list(@Query("strategy") strategy?: string, @Query("limit") limitParam?: string) {
    if (strategy !== undefined && strategy !== "report-day" && strategy !== "usib" && strategy !== "trend-setup") throw new BadRequestException("strategy must be report-day, usib or trend-setup");
    const limit = limitParam === undefined ? 30 : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BadRequestException("limit must be 1 to 200");
    return this.log.store.list(limit, strategy);
  }
}
