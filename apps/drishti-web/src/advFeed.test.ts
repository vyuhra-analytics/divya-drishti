import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ReplayController, ema as oaEma, rsi as oaRsi } from "openalgo-charts";
import { ema, rsi, type Bar } from "@drishti/shared";
import { ourFeed, resolveSymbol, searchInstruments, timeframeOf } from "./advFeed";
import { useStore } from "./store";

const T0 = 1_760_000_000 - (1_760_000_000 % 60);
const bars: Bar[] = Array.from({ length: 60 }, (_, i) => {
  const close = 9000 + Math.sin(i / 4) * 40 + i;
  return { time: T0 + i * 60, open: close - 2, high: close + 5, low: close - 5, close, volume: 100 + i };
});

beforeEach(() => {
  useStore.setState({ quotes: {} });
  globalThis.fetch = mock(async () => ({ ok: true, status: 200, json: async () => bars })) as never;
});

test("timeframeOf maps openalgo interval codes to ours", () => {
  expect(timeframeOf("1m")).toBe("1m");
  expect(timeframeOf("5m")).toBe("5m");
  expect(timeframeOf("60m")).toBe("1h");
  expect(timeframeOf("1h")).toBe("1h");
  expect(timeframeOf("1D")).toBe("1d");
  expect(timeframeOf("3m")).toBeUndefined();
  expect(timeframeOf("W")).toBeUndefined();
});

test("getBars serves our history in openalgo shape, honouring from/to and rejecting unknown intervals", async () => {
  const feed = ourFeed();
  const all = await feed.getBars({ symbol: "MCX:CRUDEOIL", exchange: "MCX", interval: "1m" });
  expect(all).toHaveLength(60);
  expect(all[0]).toEqual({ time: bars[0].time, open: bars[0].open, high: bars[0].high, low: bars[0].low, close: bars[0].close, volume: bars[0].volume });
  const part = await feed.getBars({ symbol: "MCX:CRUDEOIL", exchange: "MCX", interval: "1m", from: bars[10].time, to: bars[19].time });
  expect(part).toHaveLength(10);
  await expect(feed.getBars({ symbol: "MCX:CRUDEOIL", exchange: "MCX", interval: "3m" })).rejects.toThrow(/isn't available/);
});

test("live quotes extend the last candle and open the next one", async () => {
  const feed = ourFeed();
  await feed.getBars({ symbol: "MCX:CRUDEOIL", exchange: "MCX", interval: "1m" });
  const seen: { time: number; close: number }[] = [];
  const stop = feed.subscribeBars!({ symbol: "MCX:CRUDEOIL", exchange: "MCX", interval: "1m" }, (b) => seen.push({ time: b.time, close: b.close }));
  const lastBar = bars[bars.length - 1];
  const q = (price: number, atSec: number) => ({ "MCX:CRUDEOIL": { symbol: "MCX:CRUDEOIL", price, time: atSec * 1000, volume: 1, delayedBy: 0, source: "upstox" } as never });
  useStore.setState({ quotes: q(9123, lastBar.time + 20) });
  useStore.setState({ quotes: q(9130, lastBar.time + 70) }); // next minute
  stop();
  useStore.setState({ quotes: q(9140, lastBar.time + 80) }); // unsubscribed: ignored
  expect(seen.map((s) => s.close)).toEqual([9123, 9130]);
  expect(seen[1].time).toBe(lastBar.time + 60);
});

test("openalgo's RSI and EMA agree with ours (Wilder RSI, SMA-seeded EMA as in TradingView)", () => {
  const closes = bars.map((b) => b.close);
  const at = (pts: { time: number; value: number }[], theirs: number[]) =>
    pts.forEach((p) => expect(theirs[bars.findIndex((b) => b.time === p.time)]).toBeCloseTo(p.value, 6));
  at(rsi(bars, 14), oaRsi(closes, 14));
  at(ema(bars, 20), oaEma(closes, 20));
});

test("overlapping history requests for the same window share one fetch", async () => {
  const feed = ourFeed();
  const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls;
  const before = calls.length;
  const req = { symbol: "MCX:CRUDEOIL", exchange: "MCX", interval: "5m" };
  await Promise.all([feed.getBars(req), feed.getBars(req), feed.getBars({ ...req, from: bars[5].time })]);
  expect(calls.length - before).toBe(1);
  await feed.getBars(req); // after it settled, a new request is allowed
  expect(calls.length - before).toBe(2);
});

test("live candles are tracked but not drawn while the feed is paused (replay)", async () => {
  let paused = false;
  const feed = ourFeed(() => paused);
  await feed.getBars({ symbol: "MCX:CRUDEOIL", exchange: "MCX", interval: "1m" });
  const seen: number[] = [];
  const stop = feed.subscribeBars!({ symbol: "MCX:CRUDEOIL", exchange: "MCX", interval: "1m" }, (b) => seen.push(b.close));
  const q = (price: number, atSec: number) => ({ "MCX:CRUDEOIL": { symbol: "MCX:CRUDEOIL", price, time: atSec * 1000, volume: 1, delayedBy: 0, source: "upstox" } as never });
  const lastBar = bars[bars.length - 1];
  paused = true;
  useStore.setState({ quotes: q(9201, lastBar.time + 10) });
  paused = false;
  useStore.setState({ quotes: q(9202, lastBar.time + 20) });
  stop();
  expect(seen).toEqual([9202]);
});

test("replay over stored candles: every bar plays back exactly as stored, forming from 1m sub-bars, and stop restores the chart", () => {
  const five: Bar[] = Array.from({ length: 12 }, (_, i) => ({ time: T0 + i * 300, open: 9000 + i, high: 9010 + i, low: 8990 + i, close: 9005 + i, volume: 500 }));
  // five 1m bars per 5m bar that stay inside it and open/close like it
  const one: Bar[] = five.flatMap((b) =>
    Array.from({ length: 5 }, (_, k) => ({ time: b.time + k * 60, open: k === 0 ? b.open : b.close - 1, high: k === 0 ? b.high : b.close, low: k === 4 ? b.low : b.close - 3, close: k === 4 ? b.close : b.close - 1, volume: 100 })),
  );
  let shown: { time: number }[] = [];
  const series: any = { setData: (d: any[]) => (shown = d), update: (b: any) => (shown = [...shown.slice(0, -1), b]), getData: () => five, applyOptions() {}, remove() {}, priceScale: () => ({}) };
  const host: any = { emit() {}, timeScale: { barSpacing: 6, rightOffset: 0, setBarSpacing() {}, setRightOffset() {} }, primarySeries: () => series, on: () => () => {} };
  const rc = new ReplayController(host, { bars: five, subBars: one, series, startIndex: 0, barMs: 1 });
  const closed: any[] = [];
  for (let i = 0; i < 200; i++) {
    rc.step();
    const st = rc.state();
    if (st.subIndex >= st.subSteps - 1) closed.push(shown[shown.length - 1]);
    if (st.index >= st.total - 1 && st.subIndex >= st.subSteps - 1) break;
  }
  expect(new Set(closed.map((c) => c.time)).size).toBeGreaterThanOrEqual(11); // all but the bar it opened on
  expect(closed[closed.length - 1].time).toBe(five[five.length - 1].time); // ends on the last stored bar
  for (const c of closed) expect(c).toMatchObject(five.find((b) => b.time === c.time)!); // identical to the stored bar
  rc.stop();
  expect(shown).toHaveLength(12);
});

describe("the chart's symbol box", () => {
  const list = [
    { symbol: "MCX:CRUDEOIL", name: "Crude Oil (MCX)", exchange: "MCX" },
    { symbol: "MCX:NATURALGAS", name: "Natural Gas (MCX)", exchange: "MCX" },
    { symbol: "MCX:NATGASMINI", name: "Natural Gas Mini (MCX)", exchange: "MCX" },
    { symbol: "NYMEX:NG", name: "Natural Gas (NYMEX)", exchange: "NYMEX" },
  ];
  test("a bare or differently cased name means the one instrument it names; an ambiguous or unknown one means none", () => {
    expect(resolveSymbol("MCX:NATURALGAS", list)).toBe("MCX:NATURALGAS");
    expect(resolveSymbol("naturalgas", list)).toBe("MCX:NATURALGAS");
    expect(resolveSymbol(" natgas mini ", list)).toBe("MCX:NATGASMINI");
    expect(resolveSymbol("NG", list)).toBe("NYMEX:NG");
    expect(resolveSymbol("GAS", list)).toBeUndefined();
    expect(resolveSymbol("", list)).toBeUndefined();
    const twice = [...list, { symbol: "NYMEX:NATURALGAS", name: "x", exchange: "NYMEX" }];
    expect(resolveSymbol("NATURALGAS", twice)).toBeUndefined(); // two instruments share the bare name
  });
  test("the search offers every instrument whose code or name holds all the words typed", () => {
    expect(searchInstruments("natural gas", list).map((m) => m.symbol)).toEqual(["MCX:NATURALGAS", "MCX:NATGASMINI", "NYMEX:NG"]);
    expect(searchInstruments("mini", list).map((m) => m.symbol)).toEqual(["MCX:NATGASMINI"]);
    expect(searchInstruments("", list)).toHaveLength(4);
    expect(searchInstruments("zzz", list)).toEqual([]);
  });
});
