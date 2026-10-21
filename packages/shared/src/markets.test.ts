import { expect, test } from "bun:test";
import {
  applyTick,
  contractExpiry,
  daysToExpiry,
  frontMonth,
  futuresByExpiry,
  rollByVolume,
  mergeBars,
  normalizeBars,
  parseUpstoxCandles,
  parseYahooCandles,
  pickSource,
  quoteToTick,
  tvContract,
  tzOffsetSec,
  upstoxTokenExpiry,
  type MasterRow,
  type Quote,
} from "./index";

const DAY = 86_400_000;

test("frontMonth picks nearest unexpired future of the underlying", () => {
  const now = Date.UTC(2026, 9, 20);
  const rows: MasterRow[] = [
    { instrument_key: "a", trading_symbol: "CRUDEOIL FUT 19 OCT 26", instrument_type: "FUT", underlying_symbol: "CRUDEOIL", expiry: now - DAY },
    { instrument_key: "b", trading_symbol: "CRUDEOIL FUT 18 DEC 26", instrument_type: "FUT", underlying_symbol: "CRUDEOIL", expiry: now + 59 * DAY },
    { instrument_key: "c", trading_symbol: "CRUDEOIL FUT 19 NOV 26", instrument_type: "FUT", underlying_symbol: "CRUDEOIL", expiry: now + 30 * DAY },
    { instrument_key: "d", trading_symbol: "CRUDEOILM FUT 19 NOV 26", instrument_type: "FUT", underlying_symbol: "CRUDEOILM", expiry: now + 30 * DAY },
    { instrument_key: "e", trading_symbol: "CRUDEOIL 9000 CE", instrument_type: "CE", underlying_symbol: "CRUDEOIL", expiry: now + 2 * DAY },
  ];
  expect(frontMonth(rows, "CRUDEOIL", now)?.instrument_key).toBe("c");
  expect(frontMonth(rows, "NATURALGAS", now)).toBeUndefined();
});

test("tvContract builds dated TradingView codes", () => {
  expect(tvContract("MCX:CRUDEOIL", Date.UTC(2026, 10, 19))).toBe("MCX:CRUDEOILX2026");
  expect(tvContract("MCX:NATURALGAS", Date.UTC(2026, 9, 27))).toBe("MCX:NATURALGASV2026");
});

test("pickSource prefers fresh primary, falls back, then keeps most recent when all stale", () => {
  const p = ["upstox", "tradingview"] as const;
  expect(pickSource({ upstox: 990, tradingview: 995 }, [...p], 1000, 15)).toBe("upstox");
  expect(pickSource({ upstox: 900, tradingview: 995 }, [...p], 1000, 15)).toBe("tradingview");
  expect(pickSource({ tradingview: 995 }, [...p], 1000, 15)).toBe("tradingview");
  expect(pickSource({ upstox: 500, tradingview: 700 }, [...p], 1000, 15)).toBe("tradingview");
  expect(pickSource({}, [...p], 1000, 15)).toBeUndefined();
});

test("quoteToTick uses volume delta and skips no-trade repeats", () => {
  const q = (price: number, volume?: number): Quote => ({ symbol: "X", price, time: 1, volume, source: "demo", delayedBy: 0 });
  expect(quoteToTick(undefined, q(10, 100))).toEqual({ symbol: "X", time: 1, price: 10, size: 0 });
  expect(quoteToTick(q(10, 100), q(10, 100))).toBeNull();
  expect(quoteToTick(q(10, 100), q(10, 130))).toMatchObject({ price: 10, size: 30 });
  expect(quoteToTick(q(10, 100), q(11, 90))).toMatchObject({ price: 11, size: 0 });
  expect(quoteToTick(q(10), q(11))).toMatchObject({ price: 11, size: 0 });
});

test("upstoxTokenExpiry is the next 03:30 IST", () => {
  // 2026-10-20 16:00 IST = 10:30 UTC → expires 2026-10-21 03:30 IST = 2026-10-20 22:00 UTC
  expect(upstoxTokenExpiry(Date.UTC(2026, 9, 20, 10, 30))).toBe(Date.UTC(2026, 9, 20, 22, 0));
  // 02:00 IST (before 03:30) → same morning 03:30 IST
  expect(upstoxTokenExpiry(Date.UTC(2026, 9, 20, 20, 30))).toBe(Date.UTC(2026, 9, 20, 22, 0));
});

test("tzOffsetSec handles IST and New York DST", () => {
  expect(tzOffsetSec("Asia/Kolkata", Date.UTC(2026, 9, 20, 10))).toBe(19800);
  expect(tzOffsetSec("America/New_York", Date.UTC(2026, 9, 20, 10))).toBe(-14400); // EDT
  expect(tzOffsetSec("America/New_York", Date.UTC(2026, 11, 20, 10))).toBe(-18000); // EST
});

test("applyTick buckets 1h/1d in exchange time", () => {
  const tick = (iso: string) => ({ symbol: "X", time: Date.parse(iso), price: 1, size: 1 });
  // 09:45 IST → 1h bucket starts 09:00 IST (03:30Z), 1d bucket at IST midnight (18:30Z previous day)
  expect(applyTick(undefined, tick("2026-10-20T04:15:00Z"), 3600, 19800).time).toBe(Date.parse("2026-10-20T03:30:00Z") / 1000);
  expect(applyTick(undefined, tick("2026-10-20T04:15:00Z"), 86400, 19800).time).toBe(Date.parse("2026-10-19T18:30:00Z") / 1000);
  // New York: 1d bucket at ET midnight = 04:00Z in EDT, matching Yahoo's daily labels
  expect(applyTick(undefined, tick("2026-10-20T15:00:00Z"), 86400, -14400).time).toBe(Date.parse("2026-10-20T04:00:00Z") / 1000);
});

test("history parsers: Yahoo skips nulls, Upstox sorts ascending, mergeBars dedupes", () => {
  const yahoo = { chart: { result: [{ timestamp: [60, 120, 180], indicators: { quote: [{ open: [1, null, 3], high: [2, null, 4], low: [0.5, null, 2], close: [1.5, null, 3.5], volume: [10, null, 30] }] } }] } };
  expect(parseYahooCandles(yahoo)).toEqual([
    { time: 60, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    { time: 180, open: 3, high: 4, low: 2, close: 3.5, volume: 30 },
  ]);
  const upstox = { data: { candles: [["2026-10-20T09:01:00+05:30", 9, 9, 9, 9, 5, 0], ["2026-10-20T09:00:00+05:30", 8, 8, 8, 8, 4, 0]] } };
  const bars = parseUpstoxCandles(upstox);
  expect(bars.map((b) => b.time)).toEqual([Date.parse("2026-10-20T03:30:00Z") / 1000, Date.parse("2026-10-20T03:31:00Z") / 1000]);
  expect(mergeBars([{ ...bars[0], close: 1 }], bars).map((b) => b.close)).toEqual([8, 9]);
});

test("normalizeBars snaps partial bars to the bucket and rounds float noise", () => {
  const bars = [
    { time: 1792515720, open: 98.1, high: 98.2, low: 98.0, close: 98.10000038, volume: 5 }, // 17:02:00Z
    { time: 1792515805, open: 98.12000274658203, high: 98.13, low: 98.11, close: 98.12000274658203, volume: 2 }, // 17:03:25Z partial
  ];
  expect(normalizeBars(bars, 60, "America/New_York", 2)).toEqual([
    { time: 1792515720, open: 98.1, high: 98.2, low: 98, close: 98.1, volume: 5 },
    { time: 1792515780, open: 98.12, high: 98.13, low: 98.11, close: 98.12, volume: 2 },
  ]);
});

test("rollByVolume moves to the next month once it out-trades the nearest, otherwise stays", () => {
  const near = { instrument_key: "oct", trading_symbol: "NATURALGAS FUT 27 OCT 26", instrument_type: "FUT", underlying_symbol: "NATURALGAS", expiry: 2 };
  const next = { instrument_key: "nov", trading_symbol: "NATURALGAS FUT 24 NOV 26", instrument_type: "FUT", underlying_symbol: "NATURALGAS", expiry: 3 };
  const vol = (v: Record<string, number | undefined>) => (r: MasterRow) => v[r.instrument_key];
  expect(rollByVolume([near, next], vol({ oct: 70000, nov: 12000 }))?.instrument_key).toBe("oct");
  expect(rollByVolume([near, next], vol({ oct: 9000, nov: 41000 }))?.instrument_key).toBe("nov");
  expect(rollByVolume([near, next], vol({ oct: undefined, nov: 41000 }))?.instrument_key).toBe("oct"); // unknown → expiry rule
  expect(rollByVolume([near], vol({}))?.instrument_key).toBe("oct");
  expect(futuresByExpiry([next, near], "NATURALGAS", 1).map((r) => r.instrument_key)).toEqual(["oct", "nov"]);
});

test("contract expiry from the Upstox label, days counted in IST", () => {
  expect(contractExpiry("CRUDEOIL FUT 19 NOV 26")).toBe(Date.UTC(2026, 10, 19));
  expect(contractExpiry("NYMEX:CL")).toBeUndefined();
  expect(daysToExpiry("NATURALGAS FUT 27 OCT 26", Date.parse("2026-10-21T08:00:00+05:30"))).toBe(6);
  expect(daysToExpiry("NATURALGAS FUT 27 OCT 26", Date.parse("2026-10-27T23:00:00+05:30"))).toBe(0);
  expect(daysToExpiry("CRUDEOIL FUT 19 NOV 26", Date.parse("2026-10-20T23:00:00Z"))).toBe(29); // 04:30 IST on 21 Oct
});
