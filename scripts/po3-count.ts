// Count the Power of 3 setup (a London sweep of the Asian range that closes back inside, see packages/shared/src/po3.ts) on the candles the API serves, and
// compare how often price then reached the other side of the range by 12:00 New York time with the same measure on the days without a setup.
//   bun run scripts/po3-count.ts [--symbol=NYMEX:CL] [--tf=5m] [--api=http://127.0.0.1:3001]
// MCX has no Asian range (it trades the last half hour of that window), so the symbol should be a NYMEX one. Yahoo serves about 60 days of 5m bars, so the
// counts are small: they say how often the setup appears, not whether it works.
import { po3Outcome, po3Stats, po3Sweeps } from "../packages/shared/src";

const arg = (n: string, d: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
const symbol = arg("symbol", "NYMEX:CL");
const tf = arg("tf", "5m");
const api = arg("api", "http://127.0.0.1:3001");

const res = await fetch(`${api}/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}`);
if (!res.ok) throw new Error(`bars answered HTTP ${res.status}`);
const bars = (await res.json()) as { time: number; open: number; high: number; low: number; close: number }[];
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
console.log(`${symbol} ${tf}: ${bars.length} bars, ${day(bars[0].time)} to ${day(bars[bars.length - 1].time)}`);

const events = po3Sweeps(bars);
const stats = po3Stats(bars);
for (const e of events) {
  const o = po3Outcome(bars, e);
  console.log(`${e.day}  ${e.bias.padEnd(7)} swept ${e.side.padEnd(4)} range ${e.rangeLow.toFixed(2)}-${e.rangeHigh.toFixed(2)}  confirmed ${new Date(e.confirmAt * 1000).toISOString().slice(11, 16)}Z  ${o.reachedOpposite ? "reached the other side" : "did not reach the other side"}  (${(o.favourableRange * 100).toFixed(0)}% of the range)`);
}
const pct = (v: number | undefined) => (v === undefined ? "n/a" : `${(v * 100).toFixed(0)}%`);
console.log(`\ndays with an Asian range and a London session: ${stats.days} | setups: ${stats.events} (${stats.bearish} bearish, ${stats.bullish} bullish)`);
console.log(`after a setup, price reached the other side of the range by 12:00: ${stats.reached} of ${stats.events}${stats.events ? ` (${pct(stats.reached / stats.events)})` : ""}`);
console.log(`on days without a setup, price touched the range low by 12:00: ${pct(stats.baselineLow)}, the range high: ${pct(stats.baselineHigh)}`);
if (stats.events < 30) console.log(`\nOnly ${stats.events} setups: far too few to say whether it works.`);
