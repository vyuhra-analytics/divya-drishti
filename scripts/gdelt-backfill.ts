// Backfill crude-oil headlines from GDELT's 15-minute GKG files into Postgres (`gdelt_headlines`), for the sentiment study (deviation D1).
//   bun run gdelt:backfill -- --from=2026-04-23 --to=2026-10-23 [--concurrency=6] [--retry-failed]
// Resumable: a batch already read (`gdelt_batches`) is skipped, so a stopped run carries on. The earliest batch holding a headline keeps it, whatever order
// the downloads finish in. GDELT is free and open and must be credited (https://www.gdeltproject.org); nothing from it is committed to the repository.
import { SQL } from "bun";
import { batchTimes, extractHeadlines, gkgUrl, parseGkg, unzipFirstEntry } from "../packages/shared/src/gdelt";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const day = (s: string | undefined, fallback: number) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : fallback);
const to = day(arg("to"), Math.floor(Date.now() / 86_400_000) * 86_400_000);
const from = day(arg("from"), to - 30 * 86_400_000);
const concurrency = Math.min(8, Math.max(1, Number(arg("concurrency") ?? 6)));
const retryFailed = process.argv.includes("--retry-failed");
if (!(from < to)) throw new Error("--from must be before --to (YYYY-MM-DD)");

const sql = new SQL(process.env.DATABASE_URL!);
const done = new Set<number>(
  ((await sql`SELECT batch_at FROM gdelt_batches WHERE status IN ('ok', 'missing') OR (${retryFailed} = false AND status = 'failed')`) as { batch_at: Date }[]).map((r) => new Date(r.batch_at).getTime()),
);
const todo = batchTimes(from, to).filter((t) => !done.has(t));
console.log(`GDELT backfill ${new Date(from).toISOString().slice(0, 10)} to ${new Date(to).toISOString().slice(0, 10)}: ${todo.length} batches to read, ${concurrency} at a time`);

async function fetchBatch(t: number): Promise<{ status: "ok" | "missing" | "failed"; rows: number; kept: number }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(gkgUrl(t), { headers: { "User-Agent": "divya-drishti-research (personal; https://github.com/vyuhra-analytics/divya-drishti)" }, signal: AbortSignal.timeout(90_000) });
      if (res.status === 404) return { status: "missing", rows: 0, kept: 0 };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = unzipFirstEntry(new Uint8Array(await res.arrayBuffer()));
      const rows = parseGkg(text).length;
      const heads = extractHeadlines(text);
      if (heads.length) {
        const payload = JSON.stringify(heads.map((h) => ({ key: h.key, seen_at: new Date(h.at).toISOString(), source: h.source, url: h.url, title: h.title, themes: h.themes })));
        await sql`
          INSERT INTO gdelt_headlines (key, seen_at, source, url, title, themes)
          SELECT x.key, x.seen_at::timestamptz, x.source, x.url, x.title, x.themes
          FROM jsonb_to_recordset(${payload}::text::jsonb) AS x(key text, seen_at text, source text, url text, title text, themes text)
          ON CONFLICT (key) DO UPDATE SET seen_at = EXCLUDED.seen_at, source = EXCLUDED.source, url = EXCLUDED.url, title = EXCLUDED.title, themes = EXCLUDED.themes
          WHERE EXCLUDED.seen_at < gdelt_headlines.seen_at`; // the earliest batch keeps the headline, whatever order the downloads finish in
      }
      return { status: "ok", rows, kept: heads.length };
    } catch (e) {
      if (attempt === 3) {
        console.warn(`  ${new Date(t).toISOString()} failed: ${(e as Error).message}`);
        return { status: "failed", rows: 0, kept: 0 };
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return { status: "failed", rows: 0, kept: 0 };
}

let next = 0;
let finished = 0;
let kept = 0;
let failed = 0;
const started = Date.now();
async function worker() {
  while (next < todo.length) {
    const t = todo[next++];
    const r = await fetchBatch(t);
    await sql`INSERT INTO gdelt_batches (batch_at, status, rows_total, kept) VALUES (${new Date(t).toISOString()}, ${r.status}, ${r.rows}, ${r.kept})
      ON CONFLICT (batch_at) DO UPDATE SET status = EXCLUDED.status, rows_total = EXCLUDED.rows_total, kept = EXCLUDED.kept, at = now()`;
    kept += r.kept;
    if (r.status === "failed") failed++;
    if (++finished % 100 === 0 || finished === todo.length) {
      const perMin = finished / ((Date.now() - started) / 60_000);
      console.log(`  ${finished}/${todo.length} batches, ${kept} headlines kept before dedup, ${failed} failed, ${perMin.toFixed(0)} batches a minute, about ${Math.round((todo.length - finished) / Math.max(perMin, 0.1))} min left (at ${new Date(t).toISOString().slice(0, 16)})`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
const [{ n, first, last }] = (await sql`SELECT count(*)::int AS n, min(seen_at) AS first, max(seen_at) AS last FROM gdelt_headlines`) as { n: number; first: Date; last: Date }[];
console.log(`done: ${finished} batches read, ${failed} failed (run again with --retry-failed); the table holds ${n} unique headlines from ${first?.toISOString()} to ${last?.toISOString()}`);
await sql.close();
