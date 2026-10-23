import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { parseTypedFigure, upcomingExceptions, type CalEvent } from "@drishti/shared";
import { CalendarService } from "./calendar.service";

const DAY = 86_400_000;

/**
 * GET /calendar?days=14: the live list the panel shows (forecast and actual filled in from the free sources, cached).
 * GET /calendar/stored?from&to&series: what the recorder has stored, with every figure in the order it was seen.
 * GET /calendar/stored/:id/eia: the full EIA report table of one stored release.
 * POST /calendar/stored/:id/observations {kind: forecast|previous, text, from?}: a figure typed in by the owner, kept under the name "typed in" and believed over a feed.
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

  /** EIA's official holiday delays still ahead for the two weekly reports, soonest first. */
  @Get("eia-schedule")
  async eiaSchedule() {
    return upcomingExceptions(await this.calendar.eiaSchedule(), Date.now()).slice(0, 6);
  }

  @Get("stored")
  stored(@Query("from") fromParam?: string, @Query("to") toParam?: string, @Query("series") series?: string) {
    const from = fromParam === undefined ? Date.now() - 14 * DAY : Date.parse(fromParam);
    const to = toParam === undefined ? Date.now() + 14 * DAY : Date.parse(toParam);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 366 * DAY) throw new BadRequestException("from and to must be dates, at most a year apart");
    if (series !== undefined && !/^[A-Za-z0-9:_]{1,80}$/.test(series)) throw new BadRequestException("bad series code");
    return this.calendar.store.list(from, to, series);
  }

  @Post("stored/:id/observations")
  async typed(@Param("id") idParam: string, @Body() body: unknown) {
    const id = Number(idParam);
    if (!Number.isInteger(id) || id < 1) throw new BadRequestException("bad id");
    const fig = parseTypedFigure(body);
    if ("error" in fig) throw new BadRequestException(fig.error);
    if (!(await this.calendar.store.exists(id))) throw new NotFoundException("no such stored event");
    const added = await this.calendar.store.addObservations(id, [{ kind: fig.kind, text: fig.text, num: fig.num, unit: fig.unit, source: fig.source }]);
    return { ok: true, added };
  }

  @Get("stored/:id/eia")
  eia(@Param("id") idParam: string) {
    const id = Number(idParam);
    if (!Number.isInteger(id) || id < 1) throw new BadRequestException("bad id");
    return this.calendar.store.eiaValues(id);
  }
}
