import { Controller, Get, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { canaryInterval, FIXTURE_SAMPLES, formatCanaryTable, mapLimit, runCanary, SOURCES, withUserAgent, type CanaryResult, type FixtureSample } from "@drishti/shared";

const HOUR = 3600_000;
const HISTORY = 24; // results kept per source
const FIRST_RUN_DELAY_MS = 4_000; // let the server finish starting before probing the internet
const HEAVY_DELAY_MS = 10 * 60_000; // daily-sized downloads (JODI) do not run on every dev restart

/**
 * Source canaries: every few minutes to hours, each source's real code path runs against the live provider and is checked
 * (see shared canary.ts). Results stay in memory, newest last; a start-up table goes to the console. Set CANARIES=off to disable.
 */
@Injectable()
export class CanaryService implements OnModuleInit, OnModuleDestroy {
  private history = new Map<string, CanaryResult[]>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly io = { fetch: (input: string | URL, init?: RequestInit) => fetch(input, withUserAgent(input, init)), env: process.env, now: Date.now };

  onModuleInit() {
    if (process.env.CANARIES?.trim().toLowerCase() === "off") return;
    const light = FIXTURE_SAMPLES.filter((s) => (s.everyMs ?? HOUR) < 24 * HOUR);
    const heavy = FIXTURE_SAMPLES.filter((s) => !light.includes(s));
    this.timers.push(
      setTimeout(async () => {
        const first = await mapLimit(light, 3, (s) => this.check(s));
        console.log(`source canaries (${new Date().toLocaleTimeString()}):\n${formatCanaryTable(first)}`);
        for (const s of light) this.schedule(s);
      }, FIRST_RUN_DELAY_MS),
      setTimeout(() => heavy.forEach((s) => void this.check(s).then(() => this.schedule(s))), HEAVY_DELAY_MS),
    );
  }

  onModuleDestroy() {
    this.timers.forEach(clearTimeout);
  }

  /** The next probe waits longer for riskier sources: low-risk hourly, medium 2 h, high 6 h (see SOURCES). */
  private schedule(s: FixtureSample) {
    this.timers.push(
      setTimeout(async () => {
        await this.check(s);
        this.schedule(s);
      }, canaryInterval(s.source, s.everyMs ?? HOUR)),
    );
  }

  private async check(s: FixtureSample): Promise<CanaryResult> {
    const r = await runCanary(s, this.io);
    const list = this.history.get(s.id) ?? [];
    list.push(r);
    this.history.set(s.id, list.slice(-HISTORY));
    if (r.status !== "ok" && r.status !== "skipped") console.warn(`canary ${s.id}: ${r.status} ${r.detail ?? ""}`);
    return r;
  }

  /** Newest result per source with its recent history of statuses. Sources not yet checked are absent. */
  report() {
    return [...this.history.entries()].map(([id, list]) => ({ ...list[list.length - 1]!, recent: list.map((r) => ({ at: r.at, status: r.status })) }));
  }
}

/** GET /canaries → { canaries: latest result per source with recent statuses, sources: the registry of every external source }. */
@Controller("canaries")
export class CanaryController {
  constructor(private readonly service: CanaryService) {}

  @Get()
  canaries() {
    return { canaries: this.service.report(), sources: SOURCES };
  }
}
