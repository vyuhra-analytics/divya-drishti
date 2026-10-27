// Copy the one-minute history Upstox still serves for every listed future of our four MCX underlyings (a contract has candles from its own listing,
// about four months, and none once it is gone), into option_candles beside what the recorder keeps. Idempotent (ON CONFLICT DO NOTHING); safe to repeat.
//   bun run --env-file=.env scripts/futures-candle-backfill.ts [--from=2026-06-15]
import { SQL } from "bun";
import { mergeBars, optionCandlesUrl, optionIntradayUrl, parseUpstoxCandles, validateBars } from "../packages/shared/src";
import { OptionCandleStore } from "../apps/drishti-core-api/src/optionCandles.store";

const from = (process.argv.find((a) => a.startsWith("--from=")) ?? "--from=2026-06-15").slice(7);
const sql = new SQL(process.env.DATABASE_URL!);
const store = new OptionCandleStore(sql);
const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
if (!token) throw new Error("UPSTOX_ACCESS_TOKEN is not set");
const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (url: string): Promise<any> => {
  for (let attempt = 0; ; attempt++) {
    await pause(350);
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429 && attempt < 3) { await pause(1500 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Upstox ${res.status}`);
    return res.json();
  }
};
const day = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);

const rows = (await sql`SELECT key, raw FROM contract_master WHERE kind = 'FUT' AND underlying IN ('CRUDEOIL','CRUDEOILM','NATURALGAS','NATGASMINI') ORDER BY underlying, expiry`) as { key: string; raw: any }[];
const now = Date.now();
let total = 0;
for (const r of rows) {
  const c = r.raw;
  await store.upsertContracts([{ instrument_key: r.key, trading_symbol: c.trading_symbol, instrument_type: "FUT" as never, underlying_symbol: c.underlying_symbol, underlying_key: c.underlying_key, strike_price: 0, expiry: c.expiry, lot_size: c.lot_size }]);
  let n = 0, first = "";
  // 28-day windows from today back to --from; the dated endpoint never has today, so today comes from the intraday one
  for (let end = now; end > Date.parse(from); end -= 28 * 86_400_000) {
    const start = Math.max(end - 28 * 86_400_000, Date.parse(from));
    try {
      const json = await get(optionCandlesUrl(r.key, day(start), day(end)));
      const { bars } = validateBars(parseUpstoxCandles(json));
      if (bars.length) { n += await store.insertCandles(r.key, bars); first = new Date(bars[0].time * 1000).toISOString().slice(0, 10); }
    } catch (e) { console.log("  ", r.key, "window", day(start), "..", day(end), (e as Error).message); }
  }
  try {
    const { bars } = validateBars(mergeBars(parseUpstoxCandles(await get(optionIntradayUrl(r.key))), []));
    if (bars.length) n += await store.insertCandles(r.key, bars);
  } catch {}
  total += n;
  console.log(c.trading_symbol.padEnd(28), "new candles", String(n).padStart(6), first && `earliest ${first}`);
}
console.log("inserted", total);
await sql.close();
