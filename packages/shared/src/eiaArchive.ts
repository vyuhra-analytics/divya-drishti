// EIA's own archive of every Weekly Petroleum Status Report release as it was published (www.eia.gov/petroleum/supply/weekly/archive/): one folder per
// release with the report's tables as CSV (`csv/table1.csv` to `table14.csv`), the same files our release-day watcher reads for the current week.
// The archive is what lets a past week be stored AS FIRST PUBLISHED (EIA's API only serves later, revised values). Pure, so the index parsing is tested.
import { zonedTime } from "./eventSeries";

export const ARCHIVE_BASE = "https://www.eia.gov/petroleum/supply/weekly/archive";

export interface ArchiveRelease {
  /** the release's folder name: `2026_10_21`, or `2022_06_17_data` for the few data-only re-releases */
  folder: string;
  /** the release date, YYYY-MM-DD (New York) */
  day: string;
  year: number;
}

/** Every release the archive's index page links to, newest first, each once. */
export function parseArchiveIndex(html: string): ArchiveRelease[] {
  const seen = new Map<string, ArchiveRelease>();
  for (const m of html.matchAll(/href="[^"]*\/archive\/(\d{4})\/(\d{4}_\d{2}_\d{2}(?:_data)?)\/wpsr_[^"]*"/g)) {
    const [, year, folder] = m;
    if (!seen.has(folder)) seen.set(folder, { folder, year: Number(year), day: folder.slice(0, 10).replaceAll("_", "-") });
  }
  return [...seen.values()].sort((a, b) => b.folder.localeCompare(a.folder));
}

/** One of the report's tables as a CSV file of that release. */
export const archiveTableUrl = (r: ArchiveRelease, table: number) => `${ARCHIVE_BASE}/${r.year}/${r.folder}/csv/table${table}.csv`;

/**
 * When the release came out: 10:30 New York on the folder's date. EIA moves a few releases to a later time on a holiday week, which the folder does
 * not say, so this is a close estimate: a backfilled report is marked as stored after the fact and its arrival delay is never read as the watcher's.
 */
export function archiveReleaseTime(r: ArchiveRelease): number {
  const [y, m, d] = r.day.split("-").map(Number);
  return zonedTime("America/New_York", y, m - 1, d, 10, 30);
}
