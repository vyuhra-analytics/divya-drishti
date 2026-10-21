import { beforeEach, expect, mock, test } from "bun:test";
import { ema as oaEma, rsi as oaRsi } from "openalgo-charts";
import { ema, rsi, type Bar } from "@drishti/shared";
import { ourFeed, timeframeOf } from "./advFeed";
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
