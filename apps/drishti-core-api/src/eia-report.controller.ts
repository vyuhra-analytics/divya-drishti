import { BadRequestException, Controller, Get, NotFoundException, Query } from "@nestjs/common";
import { analyzeReport } from "@drishti/shared";
import { EiaReportService } from "./eia-report.service";

/**
 * GET /eia-report?report=WPSR|WNGSR&week=YYYY-MM-DD&forecast=-1.2: the newest stored official EIA report (or a given week) with every row, the official
 *   release time, how long after it we stored it, and the analysis (the surprise uses `forecast` when given, else the forecast recorded for the release).
 * GET /eia-report/arrivals: the delay log, newest first.
 */
@Controller("eia-report")
export class EiaReportController {
  constructor(private readonly reports: EiaReportService) {}

  @Get()
  async latest(@Query("report") report?: string, @Query("week") week?: string, @Query("forecast") forecastParam?: string) {
    if (report !== "WPSR" && report !== "WNGSR") throw new BadRequestException("report must be WPSR or WNGSR");
    if (week !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new BadRequestException("week must be YYYY-MM-DD");
    const found = await this.reports.store.latest(report, week);
    if (!found) throw new NotFoundException("no stored report yet: the watcher stores one at the next release");
    let forecast = forecastParam === undefined || forecastParam === "" ? undefined : Number(forecastParam);
    if (forecast !== undefined && (!Number.isFinite(forecast) || Math.abs(forecast) > 10_000)) throw new BadRequestException("forecast must be a number");
    let forecastSource = forecast === undefined ? undefined : "typed in";
    if (forecast === undefined) {
      const recorded = await this.reports.store.forecastFor(found.eventId);
      forecast = recorded?.value;
      forecastSource = recorded?.source;
    }
    const analysis = analyzeReport({ report, periodEnd: Date.parse(found.weekEnding), releasedAt: found.officialReleaseAt, rows: found.rows }, { forecast });
    return { ...found, forecast: forecast === undefined ? undefined : { value: forecast, source: forecastSource }, analysis };
  }

  @Get("arrivals")
  arrivals() {
    return this.reports.store.arrivals();
  }
}
