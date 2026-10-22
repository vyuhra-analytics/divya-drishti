import { expect, mock, test } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import type { Bar, OptionContract } from "@drishti/shared";
import { OptionCandlesController } from "./optionCandles.controller";
import { recordOptionCandles, type RecordDeps } from "./optionCandles.run";

// The recorder with Upstox and the database replaced by fakes: which contracts it asks for, that a repeat adds nothing, that one failing contract
// does not stop the rest, and that impossible candles never reach the table. The live run is checked by hand and by `bun run smoke`.
const ist = (iso: string) => Date.parse(`${iso}+05:30`);
const E1 = Date.UTC(2026, 10, 17);
const E2 = Date.UTC(2026, 11, 16);
const E3 = Date.UTC(2027, 0, 15);
let serial = 600000;
const futureKey = (underlying: string, expiry: number) => `MCX_FO|${underlying === "CRUDEOIL" ? 5 : 6}${expiry === E1 ? 1 : expiry === E2 ? 2 : 3}0000`;
const mk = (underlying: string, expiry: number, strike: number, type: "CE" | "PE"): OptionContract => ({
  instrument_key: `MCX_FO|${serial++}`,
  trading_symbol: `${underlying} ${strike} ${type}`,
  instrument_type: type,
  underlying_symbol: underlying,
  underlying_key: futureKey(underlying, expiry),
  strike_price: strike,
  expiry,
  lot_size: 100,
});
const strikes = (lo: number, hi: number, step: number) => Array.from({ length: (hi - lo) / step + 1 }, (_, i) => lo + i * step);
const contracts: OptionContract[] = [
  ...[E1, E2, E3].flatMap((e) => strikes(9000, 9700, 50).flatMap((k) => [mk("CRUDEOIL", e, k, "CE"), mk("CRUDEOIL", e, k, "PE")])),
  ...[E1, E2].flatMap((e) => strikes(200, 300, 5).flatMap((k) => [mk("NATGASMINI", e, k, "CE"), mk("NATGASMINI", e, k, "PE")])),
];
const quoteJson = {
  data: Object.fromEntries(
    [...new Set(contracts.map((c) => c.underlying_key))].map((k, i) => [`MCX_FO:F${i}`, { instrument_token: k, last_price: k.startsWith("MCX_FO|5") ? 9347 : 262 }]),
  ),
};

const candle = (min: number, over: Partial<Record<"open" | "high" | "low" | "close" | "volume" | "oi", number>> = {}) => [
  `2026-10-22T20:${String(min).padStart(2, "0")}:00+05:30`,
  over.open ?? 500,
  over.high ?? 505,
  over.low ?? 498,
  over.close ?? 503,
  over.volume ?? 12,
  over.oi ?? 1500 + min,
];

function fakes(opts: { failKey?: (key: string) => boolean; candlesFor?: (key: string) => unknown[]; intradayFor?: (key: string) => unknown[] } = {}) {
  const urls: string[] = [];
  const stored = new Map<string, Map<number, Bar>>();
  const upserted: OptionContract[][] = [];
  const deps: RecordDeps = {
    now: ist("2026-10-22T23:45:00"),
    lastRunAt: ist("2026-10-21T23:45:00"),
    contracts: async () => contracts,
    get: async (url) => {
      urls.push(url);
      if (url.includes("market-quote/quotes")) return quoteJson;
      if (url.includes("/intraday/")) {
        const k = decodeURIComponent(url.split("/intraday/")[1].split("/")[0]);
        return { data: { candles: opts.intradayFor ? opts.intradayFor(k) : [] } };
      }
      const key = decodeURIComponent(url.split("historical-candle/")[1].split("/")[0]);
      if (opts.failKey?.(key)) throw new Error("Upstox 500");
      return { data: { candles: opts.candlesFor ? opts.candlesFor(key) : [candle(2), candle(1), candle(0)] } };
    },
    store: {
      upsertContracts: async (c) => void upserted.push(c),
      insertCandles: async (key, bars) => {
        const m = stored.get(key) ?? new Map<number, Bar>();
        let added = 0;
        for (const b of bars) {
          if (!m.has(b.time)) {
            m.set(b.time, b);
            added++;
          }
        }
        stored.set(key, m);
        return added;
      },
    },
  };
  return { deps, urls, stored, upserted };
}

test("it records the nearest two expiries of crude and gas mini around the money, over the window since the last run", async () => {
  const f = fakes();
  const s = await recordOptionCandles(f.deps);
  expect(s.contracts).toBe(2 * 22 + 2 * 22);
  expect(s).toMatchObject({ fetched: 88, failed: 0, candles: 88 * 3, inserted: 88 * 3, dropped: 0, window: { from: "2026-10-20", to: "2026-10-22" } });
  expect(f.upserted[0]).toHaveLength(88);
  const candleUrls = f.urls.filter((u) => u.includes("historical-candle"));
  const dated = candleUrls.filter((u) => !u.includes("/intraday/"));
  expect(dated).toHaveLength(88);
  expect(dated.every((u) => u.endsWith("/minutes/1/2026-10-22/2026-10-20"))).toBe(true);
  expect(candleUrls.filter((u) => u.includes("/intraday/"))).toHaveLength(88); // today comes from the intraday endpoint
  expect(new Set(f.upserted[0].map((c) => c.expiry))).toEqual(new Set([E1, E2]));
  const first = [...f.stored.values()][0].values().next().value as Bar;
  expect(first.oi).toBeGreaterThanOrEqual(1500); // open interest is kept, not just prices
});

test("today's session is taken from the intraday endpoint and joins the earlier days; a failing intraday call does not lose the dated candles", async () => {
  const f = fakes({ intradayFor: () => [candle(4), candle(3)] }); // 3 dated candles (minutes 0 to 2) + 2 from today (3 and 4)
  const s = await recordOptionCandles(f.deps);
  expect(s).toMatchObject({ fetched: 88, candles: 88 * 5, inserted: 88 * 5 });
  const times = [...[...f.stored.values()][0].keys()];
  expect(times).toHaveLength(5);
  const base = fakes({ intradayFor: () => [candle(4)] });
  const orig = base.deps.get;
  base.deps.get = async (url) => (url.includes("/intraday/") ? Promise.reject(new Error("intraday down")) : orig(url));
  expect(await recordOptionCandles(base.deps)).toMatchObject({ fetched: 88, failed: 0, candles: 88 * 3 });
});

test("a repeat run, or an overlapping window, stores nothing twice", async () => {
  const f = fakes();
  await recordOptionCandles(f.deps);
  const again = await recordOptionCandles(f.deps);
  expect(again).toMatchObject({ fetched: 88, candles: 88 * 3, inserted: 0 });
});

test("one contract failing does not stop the others, and is counted", async () => {
  const bad = contracts.find((c) => c.underlying_symbol === "CRUDEOIL" && c.expiry === E1 && c.strike_price === 9350 && c.instrument_type === "CE")!.instrument_key;
  const f = fakes({ failKey: (k) => k === bad });
  const s = await recordOptionCandles(f.deps);
  expect(s).toMatchObject({ fetched: 87, failed: 1 });
  expect(f.stored.has(bad)).toBe(false);
  expect(f.stored.size).toBe(87);
});

test("impossible candles are refused before they are stored, and a contract with no candles is fine", async () => {
  // a high below the low, a low above the high, and a negative open interest
  const f = fakes({ candlesFor: () => [candle(0), candle(1, { high: 100 }), candle(2, { low: 900 }), candle(3, { oi: -4 })] });
  const s = await recordOptionCandles(f.deps);
  expect(s.dropped).toBe(88 * 2);
  expect(s.candles).toBe(88 * 2);
  const all = [...f.stored.values()].flatMap((m) => [...m.values()]);
  expect(all.every((b) => b.high >= b.low && b.high >= Math.max(b.open, b.close))).toBe(true);
  expect(all.some((b) => b.oi !== undefined && b.oi < 0)).toBe(false); // the bad OI was dropped from the bar, the prices kept
  expect(all.filter((b) => b.oi === undefined)).toHaveLength(88); // exactly the candle that had the negative OI
  const empty = fakes({ candlesFor: () => [] });
  expect(await recordOptionCandles(empty.deps)).toMatchObject({ fetched: 88, failed: 0, candles: 0, inserted: 0 });
});

test("with no option contracts in the master it fails loudly instead of recording nothing", async () => {
  const f = fakes();
  await expect(recordOptionCandles({ ...f.deps, contracts: async () => [] })).rejects.toThrow(/no option contracts/);
});

test("a quote failure still records, around the middle strike", async () => {
  const f = fakes();
  const s = await recordOptionCandles({ ...f.deps, get: async (url) => (url.includes("market-quote") ? Promise.reject(new Error("quotes down")) : f.deps.get(url)) });
  expect(s.contracts).toBe(88);
  expect(s.fetched).toBe(88);
});

// ---- the controller
const fakeSql = (() => Promise.resolve([])) as any;
const dbOf = () => ({ sql: fakeSql, redis: { get: async () => null } }) as any;

test("candle reads are validated before the database is touched", async () => {
  const c = new OptionCandlesController(dbOf());
  const refused = async (call: () => unknown, re: RegExp) => {
    const err = await Promise.resolve()
      .then(call)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(re);
  };
  await refused(() => c.candles(undefined, "2026-10-20", "2026-10-22"), /key must look like/);
  await refused(() => c.candles("NSE_FO|1234", "2026-10-20", "2026-10-22"), /key must look like/);
  await refused(() => c.candles("MCX_FO|582939; drop", "2026-10-20", "2026-10-22"), /key must look like/);
  await refused(() => c.candles("MCX_FO|582939", "20-10-2026", "2026-10-22"), /YYYY-MM-DD/);
  await refused(() => c.candles("MCX_FO|582939", "2026-10-20", undefined), /YYYY-MM-DD/);
  await refused(() => c.candles("MCX_FO|582939", "2026-10-22", "2026-10-20"), /not be before/);
  await refused(() => c.candles("MCX_FO|582939", "2026-01-01", "2026-10-22"), /at most 40 days/);
});

test("tick records once per closed session, never two at once, and waits half an hour after a failure", async () => {
  const c = new OptionCandlesController(dbOf());
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  (c as any).record = mock(async () => {
    calls++;
    await gate;
    return { window: { from: "a", to: "b" }, contracts: 1, fetched: 1, failed: 0, candles: 1, inserted: 1, dropped: 0 };
  });
  const evening = ist("2026-10-22T23:45:00"); // a session closed 15 minutes ago and nothing was ever recorded
  const first = c.tick(evening);
  expect(await c.tick(evening)).toBeNull(); // already running
  release();
  await first;
  expect(calls).toBe(1);
  (c as any).record = mock(async () => {
    throw new Error("Upstox down");
  });
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    expect(await c.tick(evening + 60_000)).toBeNull();
    expect((c as any).record).toHaveBeenCalledTimes(1);
    expect(await c.tick(evening + 10 * 60_000)).toBeNull(); // inside the half hour: not tried again
    expect((c as any).record).toHaveBeenCalledTimes(1);
    expect(await c.tick(evening + 31 * 60_000)).toBeNull();
    expect((c as any).record).toHaveBeenCalledTimes(2);
  } finally {
    console.warn = warn;
  }
});
