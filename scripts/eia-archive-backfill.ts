// Store past EIA Weekly Petroleum Status Reports AS FIRST PUBLISHED, from EIA's own archive of every release (www.eia.gov/petroleum/supply/weekly/archive/).
//   bun run eia:archive                              the 12 most recent releases (newest first)
//   bun run eia:archive -- --releases=270            about five years
//   bun run eia:archive -- --from=2021-01-01         every release since a date
//   bun run eia:archive -- --dry                     parse and count, store nothing
// Resumable and cheap to repeat: a week already stored is skipped after one request. Same parser as the release-day watcher; no API.
import { SQL } from "bun";
import { ARCHIVE_BASE, withUserAgent } from "../packages/shared/src";
import { backfillArchive } from "../apps/drishti-core-api/src/eia-archive.backfill";
import { PgEiaReportStore } from "../apps/drishti-core-api/src/eia-report.store";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const releases = Number(arg("releases") ?? 12);
const from = arg("from");
if (!Number.isInteger(releases) || releases < 1 || releases > 2000) throw new Error("--releases must be 1 to 2000");
if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error("--from must be YYYY-MM-DD");

const sql = new SQL(process.env.DATABASE_URL!);
const store = new PgEiaReportStore(sql);
const get = async (url: string): Promise<string | undefined> => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, withUserAgent(url, { signal: AbortSignal.timeout(30_000) }));
      if (res.status === 404) return undefined;
      if (res.ok) return await res.text();
    } catch {
      /* try once more */
    }
  }
  return undefined;
};

const summary = await backfillArchive(
  {
    index: async () => (await get(`${ARCHIVE_BASE}/`)) ?? "",
    csv: get,
    store: { hasWeek: (r, k) => store.hasWeek(r, k), eventFor: (r, p, a) => store.eventFor(r, p, a), saveReport: (id, rep, off, at) => store.saveReport(id, rep, off, at) },
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (l) => console.log(l),
  },
  { releases, from, dry: process.argv.includes("--dry") },
);
console.log(`\nconsidered ${summary.considered} releases: stored ${summary.stored} (${summary.rows} rows), already stored ${summary.alreadyStored}, failed ${summary.failed.length}`);
for (const f of summary.failed) console.log("  failed:", f);
await sql.close();
