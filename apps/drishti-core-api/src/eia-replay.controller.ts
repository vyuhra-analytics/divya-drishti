import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { REPLAY_ENTRIES, REPLAY_UNDERLYINGS, type ReplayEntry, type ReplayParams, type ReplayReport } from "@drishti/shared";
import { Db } from "./db";
import { defaultReplay, runEiaReplay } from "./eia-replay.run";

const num = (v: string | undefined, name: string, min: number, max: number, fallback: number): number => {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new BadRequestException(`${name} must be a number from ${min} to ${max}`);
  return n;
};

/**
 * GET /research/eia-replay?report=WPSR|WNGSR&underlying=&rpct=0.5&delay=1&hold=60&slip=1&threshold=3&since=2026-04-25&sensitivity=1&entry=release|amd-sweep|amd-surprise
 * The report-day strategy replayed over the one-minute candles we hold (research only: no order is placed). See eia-replay.run.ts.
 */
@Controller("research")
export class EiaReplayController {
  constructor(private readonly db: Db) {}

  @Get("eia-replay")
  async replay(
    @Query("report") report?: string,
    @Query("underlying") underlying?: string,
    @Query("rpct") rpct?: string,
    @Query("delay") delay?: string,
    @Query("hold") hold?: string,
    @Query("slip") slip?: string,
    @Query("threshold") threshold?: string,
    @Query("since") since?: string,
    @Query("sensitivity") sensitivity?: string,
    @Query("entry") entry?: string,
  ): Promise<ReplayReport> {
    if (report !== "WPSR" && report !== "WNGSR") throw new BadRequestException("report must be WPSR or WNGSR");
    const d = defaultReplay(report);
    if (underlying !== undefined && !(REPLAY_UNDERLYINGS as readonly string[]).includes(underlying)) throw new BadRequestException(`underlying must be one of ${REPLAY_UNDERLYINGS.join(", ")}`);
    if (entry !== undefined && !(REPLAY_ENTRIES as readonly string[]).includes(entry)) throw new BadRequestException(`entry must be one of ${REPLAY_ENTRIES.join(", ")}`);
    if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new BadRequestException("since must be YYYY-MM-DD");
    const params: ReplayParams = {
      report,
      entry: (entry as ReplayEntry) ?? d.entry,
      underlying: (underlying as ReplayParams["underlying"]) ?? d.underlying,
      rPct: num(rpct, "rpct", 0.05, 5, d.rPct),
      delayMin: Math.round(num(delay, "delay", 0, 30, d.delayMin)),
      holdMin: Math.round(num(hold, "hold", 5, 240, d.holdMin)),
      slip: num(slip, "slip", 0, 50, d.slip),
      threshold: num(threshold, "threshold", 0, 50, d.threshold),
      since: since ?? d.since,
    };
    return runEiaReplay(this.db.sql, params, sensitivity === "1");
  }
}
