// Load NYMEX CL hourly bars (Yahoo CL=F, 730 days) into `cl_hourly` for the sentiment study (deviation D2): `bun run cl:history`. Idempotent.
import { SQL } from "bun";
import { parseYahooCandles, validateBars } from "../packages/shared/src";

const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1h&range=730d", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(60_000) });
if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
const parsed = parseYahooCandles(await res.json());
const { bars, dropped } = validateBars(parsed);
const sql = new SQL(process.env.DATABASE_URL!);
const payload = JSON.stringify(bars.map((b) => ({ time: new Date(b.time * 1000).toISOString(), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 })));
await sql`
  INSERT INTO cl_hourly (time, open, high, low, close, volume)
  SELECT x.time::timestamptz, x.open, x.high, x.low, x.close, x.volume
  FROM jsonb_to_recordset(${payload}::text::jsonb) AS x(time text, open double precision, high double precision, low double precision, close double precision, volume double precision)
  ON CONFLICT (time) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume`;
const [{ n, first, last }] = (await sql`SELECT count(*)::int AS n, min(time) AS first, max(time) AS last FROM cl_hourly`) as { n: number; first: Date; last: Date }[];
console.log(`Yahoo gave ${parsed.length} bars, ${dropped.length} dropped as impossible; cl_hourly holds ${n} from ${first.toISOString()} to ${last.toISOString()}`);
await sql.close();
