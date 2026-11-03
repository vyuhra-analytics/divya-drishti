// Load the 1-minute CSVs pulled by dukascopy-node (timestamp ms UTC = bar open, open,high,low,close,volume) into external_bars. Idempotent.
//   bun run --env-file=.env scripts/dukascopy-load.ts [--dir=I:/divya-drishti-data/dukascopy/out] [--dry]
import { SQL } from "bun";
import { readdirSync } from "node:fs";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const dir = arg("dir") ?? "I:/divya-drishti-data/dukascopy/out";
const dry = process.argv.includes("--dry");
const sql = new SQL(process.env.DATABASE_URL!);
const CHUNK = 20_000;

for (const name of readdirSync(dir).filter((f) => f.endsWith(".csv")).sort()) {
  const symbol = name.split("-m1-")[0];
  const lines = (await Bun.file(`${dir}/${name}`).text()).trim().split("\n").slice(1);
  const rows: { t: number; o: number; h: number; l: number; c: number; v: number | null }[] = [];
  let bad = 0;
  for (const line of lines) {
    const [t, o, h, l, c, v] = line.split(",").map(Number);
    if (![t, o, h, l, c].every(Number.isFinite) || h < Math.max(o, c, l) || l > Math.min(o, c, h) || o <= 0) bad++;
    else rows.push({ t, o, h, l, c, v: Number.isFinite(v) ? v : null });
  }
  if (!dry) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = JSON.stringify(rows.slice(i, i + CHUNK));
      await sql`INSERT INTO external_bars (source, symbol, time, open, high, low, close, volume)
        SELECT 'dukascopy', ${symbol}, to_timestamp((r.t)::double precision / 1000), r.o, r.h, r.l, r.c, r.v
        FROM jsonb_to_recordset(${part}::text::jsonb) AS r(t bigint, o double precision, h double precision, l double precision, c double precision, v double precision)
        ON CONFLICT DO NOTHING`;
    }
  }
  console.log(name, rows.length, "rows", bad ? `${bad} rejected` : "", dry ? "(dry)" : "stored");
}
if (!dry) console.log(await sql`SELECT symbol, count(*)::int AS rows, min(time) AS first, max(time) AS last FROM external_bars GROUP BY symbol ORDER BY symbol`);
await sql.close();
