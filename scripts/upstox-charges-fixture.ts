// Record Upstox's own charge calculation for six sample legs (option buy and sell, small and large premium, future buy and sell) as
// packages/shared/fixtures/upstox-charges.json: `bun run fixtures:upstox-charges` (needs the dev stack for the front month and
// UPSTOX_ACCESS_TOKEN in .env). The contract test (upstoxCharges.test.ts) replays it and fails if our cost table drifts from Upstox.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseUpstoxCharges, upstoxChargesUrl } from "../packages/shared/src/index";

const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
if (!token) throw new Error("set UPSTOX_ACCESS_TOKEN in .env");
const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };

const fronts: any = await (await fetch("http://127.0.0.1:3002/fronts")).json();
const future = fronts.CRUDEOIL;
const chain: any = await (await fetch("http://127.0.0.1:3001/options?underlying=CRUDEOIL&strikes=4")).json();
const units = 100;
const gz = await (await fetch("https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz")).arrayBuffer();
const master: any[] = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(gz))));
const expiry = Date.parse(`${chain.expiry}T00:00:00Z`);
const opt = master.find((r) => r.underlying_symbol === "CRUDEOIL" && r.instrument_type === "CE" && r.strike_price === chain.atm && Math.abs(r.expiry - expiry) < 2 * 86_400_000);
if (!future || !opt) throw new Error("could not resolve the front future and the at-the-money call");
const spot = Math.round(chain.spot);

const legs = [
  { kind: "option", side: "buy", price: 500, key: opt.instrument_key },
  { kind: "option", side: "sell", price: 500, key: opt.instrument_key },
  { kind: "option", side: "buy", price: 100, key: opt.instrument_key },
  { kind: "option", side: "buy", price: 2000, key: opt.instrument_key },
  { kind: "future", side: "buy", price: spot, key: future.instrument_key },
  { kind: "future", side: "sell", price: spot, key: future.instrument_key },
] as const;

const out = [];
for (const l of legs) {
  const res = await fetch(upstoxChargesUrl(l.key, units, l.price, l.side), { headers });
  const json: any = await res.json();
  if (!parseUpstoxCharges(json)) throw new Error(`${l.kind} ${l.side} ${l.price}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 160)}`);
  out.push({ ...l, units, charges: json.data.charges });
}
writeFileSync(join(import.meta.dir, "../packages/shared/fixtures/upstox-charges.json"), JSON.stringify({ recordedAt: new Date().toISOString(), instrument: `${opt.trading_symbol} and ${future.trading_symbol}`, legs: out }, null, 1));
console.log(`saved ${out.length} legs for ${opt.trading_symbol} / ${future.trading_symbol}`);
