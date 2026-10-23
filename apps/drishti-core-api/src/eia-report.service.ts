import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
  mapLimit,
  nextPollDelay,
  parseWngsrReport,
  parseWpsrReport,
  parseWpsrTable,
  releaseAtFor,
  shouldFetch,
  weekKey,
  withUserAgent,
  WATCH,
  type EiaReport,
  type EiaReportCode,
} from "@drishti/shared";
import { Db } from "./db";
import { PgEiaReportStore } from "./eia-report.store";

const WPSR_URL = (t: number) => `https://ir.eia.gov/wpsr/table${t}.csv`;
const WNGSR_URL = "https://ir.eia.gov/ngs/wngsr.csv";

/** What the watcher needs from the database (the Postgres store implements it, tests use a fake). */
export interface WatchStore {
  nextUnstored(report: EiaReportCode, now: number): Promise<{ id: number; key: string; at: number } | undefined>;
  eventFor(report: EiaReportCode, periodEnd: number, releaseAt: number): Promise<{ id: number; scheduledAt: number; hasRows: boolean }>;
  saveReport(eventId: number, report: EiaReport, officialAt: number, storedAt: number): Promise<number>;
}

export interface WatchIO {
  text(url: string): Promise<string | undefined>;
  now(): number;
  log(line: string): void;
}

/**
 * Watches the two official EIA reports. Around each scheduled release it polls one small file every few seconds (table 1, or the gas file); the
 * moment a newer week appears it fetches the rest, parses all of it and stores every row. A release that was missed (the app was off) is stored at
 * start-up from the files still on the server. A week stored once is never fetched again.
 */
export class EiaReportWatcher {
  private readonly stored = new Map<EiaReportCode, string>(); // the newest week stored this run, so polling the same file again costs nothing
  private forced = new Set<EiaReportCode>(["WPSR", "WNGSR"]); // the first look after start-up is unconditional

  constructor(
    private readonly store: WatchStore,
    private readonly io: WatchIO,
  ) {}

  /** One pass over both reports; returns how long to wait before the next one. */
  async tick(): Promise<{ delay: number; stored: number }> {
    let delay: number = WATCH.idle;
    let stored = 0;
    for (const report of ["WPSR", "WNGSR"] as const) {
      const now = this.io.now();
      const due = await this.store.nextUnstored(report, now);
      if (this.forced.delete(report) || shouldFetch(now, due?.at)) stored += await this.pull(report);
      const after = await this.store.nextUnstored(report, this.io.now());
      delay = Math.min(delay, nextPollDelay(this.io.now(), after?.at));
    }
    return { delay, stored };
  }

  /** Looks at the official files; stores the report when its week is not stored yet. Returns the number of rows stored. */
  private async pull(report: EiaReportCode): Promise<number> {
    const head = report === "WPSR" ? await this.io.text(WPSR_URL(1)) : await this.io.text(WNGSR_URL);
    if (!head) return 0;
    const periodEnd = report === "WPSR" ? parseWpsrTable(1, head)[0]?.periodEnd : parseWngsrReport(head)?.periodEnd;
    if (periodEnd === undefined || this.stored.get(report) === weekKey(periodEnd)) return 0;

    let parsed: EiaReport | undefined;
    if (report === "WNGSR") parsed = parseWngsrReport(head);
    else {
      const files: Record<number, string | undefined> = { 1: head };
      const rest = [2, 3, 4, 5, 6, 7, 8, 9];
      const texts = await mapLimit(rest, 4, (t) => this.io.text(WPSR_URL(t)));
      rest.forEach((t, i) => (files[t] = texts[i]));
      parsed = parseWpsrReport(files); // undefined while the tables are of two different weeks: the next poll tries again
    }
    if (!parsed) return 0;

    const key = weekKey(parsed.periodEnd);
    const release = releaseAtFor(report, parsed.periodEnd);
    if (release === undefined) return 0;
    const event = await this.store.eventFor(report, parsed.periodEnd, release);
    if (event.hasRows) {
      this.stored.set(report, key);
      return 0;
    }
    const storedAt = this.io.now();
    const official = parsed.releasedAt ?? event.scheduledAt;
    const rows = await this.store.saveReport(event.id, parsed, official, storedAt);
    this.stored.set(report, key);
    this.io.log(`EIA ${report}: week ${key}, ${rows} rows stored ${((storedAt - official) / 1000).toFixed(1)} s after the official release`);
    return rows;
  }
}

@Injectable()
export class EiaReportService implements OnModuleInit, OnModuleDestroy {
  readonly store: PgEiaReportStore;
  private readonly watcher: EiaReportWatcher;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failing = false;

  constructor(db: Db) {
    this.store = new PgEiaReportStore(db.sql);
    this.watcher = new EiaReportWatcher(this.store, {
      text: async (url) => {
        try {
          const res = await fetch(url, { ...withUserAgent(url), signal: AbortSignal.timeout(8000) });
          return res.ok ? await res.text() : undefined;
        } catch {
          return undefined; // an unreachable file just means not yet
        }
      },
      now: Date.now,
      log: (line) => console.log(line),
    });
  }

  onModuleInit() {
    if (process.env.EIA_REPORT_WATCHER?.trim().toLowerCase() === "off") return;
    this.timer = setTimeout(() => void this.tick(), 20_000); // after the calendar recorder has made the week's events
  }

  onModuleDestroy() {
    clearTimeout(this.timer);
  }

  private async tick() {
    let delay: number = WATCH.idle;
    try {
      delay = (await this.watcher.tick()).delay;
      this.failing = false;
    } catch (e) {
      if (!this.failing) console.warn(`EIA report watcher: ${(e as Error).message}`); // once per outage
      this.failing = true;
    }
    this.timer = setTimeout(() => void this.tick(), delay);
  }
}
