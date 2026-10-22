import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import type { CalEvent } from "@drishti/shared";
import { CalendarService } from "./calendar.service";

const DAY = 86_400_000;

/**
 * GET /calendar?days=14: the live list the panel shows (forecast and actual filled in from the free sources, cached).
 * GET /calendar/stored?from&to&series: what the recorder has stored, with every figure in the order it was seen.
 * GET /calendar/stored/:id/eia: the full EIA report table of one stored release.
 */
@Controller("calendar")
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get()
  events(@Query("days") daysParam?: string): Promise<CalEvent[]> {
    const days = daysParam === undefined ? 14 : Number(daysParam);
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new BadRequestException("days must be 1–60");
    return this.calendar.events(days);
  }

  @Get("stored")
  stored(@Query("from") fromParam?: string, @Query("to") toParam?: string, @Query("series") series?: string) {
    const from = fromParam === undefined ? Date.now() - 14 * DAY : Date.parse(fromParam);
    const to = toParam === undefined ? Date.now() + 14 * DAY : Date.parse(toParam);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 366 * DAY) throw new BadRequestException("from and to must be dates, at most a year apart");
    if (series !== undefined && !/^[A-Za-z0-9:_]{1,80}$/.test(series)) throw new BadRequestException("bad series code");
    return this.calendar.store.list(from, to, series);
  }

  @Get("stored/:id/eia")
  eia(@Param("id") idParam: string) {
    const id = Number(idParam);
    if (!Number.isInteger(id) || id < 1) throw new BadRequestException("bad id");
    return this.calendar.store.eiaValues(id);
  }
}
