import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { PROFILE_UNDERLYINGS, type ProfileUnderlying, type TimeProfile } from "@drishti/shared";
import { Db } from "./db";
import { timeProfile } from "./time-profile";

/**
 * GET /research/time-profile?underlying=CRUDEOILM&days=60&recent=3
 * Each named window of the New York day (the five ICT killzones and the gaps between them) with its average range, how active an average bar is, volume a
 * minute and the average spread, and the high, low, range and average of every window on the latest days. From our own one-minute candles and recorded
 * feed; descriptive only (when the market is busy, not which way it goes). See time-profile.ts.
 */
@Controller("research")
export class TimeProfileController {
  constructor(private readonly db: Db) {}

  @Get("time-profile")
  async profile(@Query("underlying") underlying?: string, @Query("days") daysParam?: string, @Query("recent") recentParam?: string): Promise<TimeProfile> {
    const u = underlying ?? "CRUDEOILM";
    if (!(PROFILE_UNDERLYINGS as readonly string[]).includes(u)) throw new BadRequestException(`underlying must be one of ${PROFILE_UNDERLYINGS.join(", ")}`);
    const days = daysParam === undefined ? 60 : Number(daysParam);
    if (!Number.isInteger(days) || days < 5 || days > 180) throw new BadRequestException("days must be 5 to 180");
    const recent = recentParam === undefined ? 3 : Number(recentParam);
    if (!Number.isInteger(recent) || recent < 1 || recent > 10) throw new BadRequestException("recent must be 1 to 10");
    return timeProfile(this.db.sql, u as ProfileUnderlying, days, recent);
  }
}
