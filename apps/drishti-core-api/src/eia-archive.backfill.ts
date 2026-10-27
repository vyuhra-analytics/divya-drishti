import { archiveReleaseTime, archiveTableUrl, parseArchiveIndex, parseWpsrReport, parseWpsrTable, weekKey, type EiaReport, type EiaReportCode } from "@drishti/shared";

/** What the backfill needs from outside, so a run is tested with fakes. */
export interface ArchiveDeps {
  /** the archive's index page (HTML) */
  index(): Promise<string>;
  /** one CSV file; undefined when the archive does not have it or the request failed */
  csv(url: string): Promise<string | undefined>;
  store: {
    /** is this week of this report already stored with rows? */
    hasWeek(report: EiaReportCode, weekKey: string): Promise<boolean>;
    eventFor(report: EiaReportCode, periodEnd: number, releaseAt: number): Promise<{ id: number }>;
    saveReport(eventId: number, report: EiaReport, officialAt: number, storedAt: number): Promise<number>;
  };
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export interface ArchiveOptions {
  /** how many releases to look at, newest first (default 12) */
  releases?: number;
  /** stop at releases before this day, YYYY-MM-DD */
  from?: string;
  /** parse and count, store nothing */
  dry?: boolean;
  /** pause between requests, so a long run is polite to eia.gov (default 250 ms) */
  gapMs?: number;
}

export interface ArchiveSummary {
  considered: number;
  stored: number;
  alreadyStored: number;
  /** a file the archive did not give, or that did not parse */
  failed: string[];
  rows: number;
  /** the weeks stored, newest first */
  weeks: string[];
}

const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Stores past petroleum reports AS FIRST PUBLISHED, from EIA's own archive of every release (each release's CSV tables), newest first so the most recent
 * weeks come first. A week already stored is skipped after one request (table 1 says which week a release covers), so a stopped run carries on and a
 * repeat run costs almost nothing. The same parser as the release-day watcher reads the files: one source of truth, no API involved.
 * Backfilled reports are marked as stored after the fact (their arrival delay is not the watcher's).
 */
export async function backfillArchive(d: ArchiveDeps, opts: ArchiveOptions = {}): Promise<ArchiveSummary> {
  const gap = opts.gapMs ?? 250;
  const all = parseArchiveIndex(await d.index());
  if (!all.length) throw new Error("the archive index listed no releases (did the page change?)");
  const wanted = all.filter((r) => !opts.from || r.day >= opts.from).slice(0, opts.releases ?? 12);
  const out: ArchiveSummary = { considered: wanted.length, stored: 0, alreadyStored: 0, failed: [], rows: 0, weeks: [] };
  let streak = 0;

  for (const r of wanted) {
    const t1 = await d.csv(archiveTableUrl(r, 1));
    await d.sleep(gap);
    const head = t1 ? parseWpsrTable(1, t1)[0] : undefined;
    if (!head) {
      out.failed.push(`${r.folder}: table 1 ${t1 ? "did not parse" : "not available"}`);
      if (++streak >= MAX_CONSECUTIVE_FAILURES) {
        d.log(`stopping: ${MAX_CONSECUTIVE_FAILURES} releases in a row could not be read`);
        break;
      }
      continue;
    }
    streak = 0;
    const key = weekKey(head.periodEnd);
    if (await d.store.hasWeek("WPSR", key)) {
      out.alreadyStored++;
      d.log(`${r.folder}: week ${key} already stored`);
      continue;
    }
    const files: Record<number, string | undefined> = { 1: t1 };
    for (let t = 2; t <= 9; t++) {
      files[t] = await d.csv(archiveTableUrl(r, t));
      await d.sleep(gap);
    }
    const report = parseWpsrReport(files);
    const missing = Object.entries(files).filter(([, v]) => !v).map(([k]) => k);
    if (!report || missing.length) {
      out.failed.push(`${r.folder}: ${report ? `tables ${missing.join(", ")} missing` : "the tables did not agree on one week"}`);
      continue;
    }
    if (!opts.dry) {
      const event = await d.store.eventFor("WPSR", report.periodEnd, archiveReleaseTime(r));
      await d.store.saveReport(event.id, report, archiveReleaseTime(r), d.now());
    }
    out.stored++;
    out.rows += report.rows.length;
    out.weeks.push(key);
    d.log(`${r.folder}: week ${key} ${opts.dry ? "parsed" : "stored"}, ${report.rows.length} rows`);
  }
  return out;
}
