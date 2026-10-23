import { BadRequestException, Controller, Get, NotFoundException, Query } from "@nestjs/common";
import { EiaReportService } from "./eia-report.service";

/**
 * GET /eia-report?report=WPSR|WNGSR&week=YYYY-MM-DD: the newest stored official EIA report (or a given week) with every row, the official release
 *   time and how many seconds after it we stored it.
 * GET /eia-report/arrivals: the delay log, newest first.
 */
@Controller("eia-report")
export class EiaReportController {
  constructor(private readonly reports: EiaReportService) {}

  @Get()
  async latest(@Query("report") report?: string, @Query("week") week?: string) {
    if (report !== "WPSR" && report !== "WNGSR") throw new BadRequestException("report must be WPSR or WNGSR");
    if (week !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new BadRequestException("week must be YYYY-MM-DD");
    const found = await this.reports.store.latest(report, week);
    if (!found) throw new NotFoundException("no stored report yet: the watcher stores one at the next release");
    return found;
  }

  @Get("arrivals")
  arrivals() {
    return this.reports.store.arrivals();
  }
}
