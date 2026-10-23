// When to look for an EIA report, and which release a file belongs to. Pure; the API's watcher does the fetching and storing.
import { occurrences, seriesByCode } from "./eventSeries";
import type { EiaReportCode } from "./eiaReport";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 86_400_000;

export const WATCH = {
  /** start looking this long before the scheduled release, so the first file is caught within one poll */
  lead: 90 * SECOND,
  /** poll this often from the lead until the release has been stored */
  fast: 3 * SECOND,
  /** stop polling fast this long after the release; a late report is then looked for once a minute */
  fastFor: 10 * MINUTE,
  /** a release not stored by now is given up on (a missing report is looked for again at the next one) */
  giveUpAfter: 3 * DAY,
  /** when nothing is due */
  idle: 5 * MINUTE,
  late: MINUTE,
};

/**
 * How long to wait before the next look. `due` is the scheduled time of the earliest release not stored yet (undefined when nothing waits).
 * Fast around the release, once a minute when it is late, and never longer than the idle pause, so a rescheduled release is noticed.
 */
export function nextPollDelay(now: number, due: number | undefined): number {
  if (due === undefined || now > due + WATCH.giveUpAfter) return WATCH.idle;
  const start = due - WATCH.lead;
  if (now < start) return Math.min(WATCH.idle, Math.max(start - now, WATCH.fast));
  return now < due + WATCH.fastFor ? WATCH.fast : WATCH.late;
}

/** Whether the files are worth fetching now: from the lead before the earliest unstored release until it is given up on. */
export const shouldFetch = (now: number, due: number | undefined) => due !== undefined && now >= due - WATCH.lead && now <= due + WATCH.giveUpAfter;

/** The release time of the report covering a week (the Friday it ends): the series' own schedule applied to the following days; undefined for an unknown series. */
export function releaseAtFor(report: EiaReportCode, periodEnd: number): number | undefined {
  const def = seriesByCode(report);
  return def ? occurrences(def, periodEnd + DAY, periodEnd + 9 * DAY)[0] : undefined;
}

/** The week-ending date as the natural key the stored calendar uses (YYYY-MM-DD). */
export const weekKey = (periodEnd: number) => new Date(periodEnd).toISOString().slice(0, 10);

/** Milliseconds from the official release to our first stored copy (negative is clamped to 0: a clock a little off must not show an early arrival). */
export const arrivalDelay = (officialAt: number, storedAt: number) => Math.max(0, storedAt - officialAt);

/** Whether a scheduled release is within two minutes ahead or fifteen minutes behind: the panel looks every few seconds then. */
export function inReleaseWindow(now: number): boolean {
  return (["WPSR", "WNGSR"] as const).some((code) => {
    const def = seriesByCode(code);
    return def !== undefined && occurrences(def, now - 15 * MINUTE, now + 2 * MINUTE).length > 0;
  });
}
