import { describe, expect, it } from "bun:test";
import { candleSeconds, sessionBreaks } from "./sessionBreaks";

const bars = (times: number[]) => times.map((time) => ({ time }));
/** five-minute candles from `from` for `n` bars */
const run = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i * 300);

describe("sessionBreaks", () => {
  it("finds the close and the next open where the market was shut, and ignores a continuous run", () => {
    const day1 = run(1_000_000, 12);
    const day2 = run(1_000_000 + 12 * 300 + 9 * 3600, 12); // nine hours shut
    const b = sessionBreaks(bars([...day1, ...day2]));
    expect(b).toEqual([{ closeAt: 1_000_000 + 12 * 300, openAt: 1_000_000 + 12 * 300 + 9 * 3600, gapSec: 9 * 3600 }]);
    expect(sessionBreaks(bars(day1))).toEqual([]);
  });

  it("a short gap is a quiet market or a missing candle, not a close; the threshold is the caller's", () => {
    const t = [...run(0, 6), ...run(6 * 300 + 20 * 60, 6)]; // twenty minutes
    expect(sessionBreaks(bars(t))).toEqual([]);
    expect(sessionBreaks(bars(t), 15)).toHaveLength(1);
  });

  it("always needs at least two candle lengths, and finds each of several breaks", () => {
    const hourly = [0, 3600, 7200, 7200 + 3 * 3600, 7200 + 4 * 3600, 7200 + 4 * 3600 + 2 * 24 * 3600];
    const b = sessionBreaks(bars(hourly), 0);
    expect(b.map((x) => x.gapSec)).toEqual([2 * 3600, 2 * 24 * 3600 - 3600]);
  });

  it("daily candles and fewer than two candles have no breaks", () => {
    expect(sessionBreaks(bars([0, 86_400, 3 * 86_400]))).toEqual([]);
    expect(sessionBreaks(bars([5]))).toEqual([]);
    expect(candleSeconds(bars([]))).toBe(0);
  });

  it("is causal: a later candle never changes a break already found", () => {
    const base = [...run(0, 6), ...run(6 * 300 + 3 * 3600, 6)];
    const a = sessionBreaks(bars(base));
    const b = sessionBreaks(bars([...base, ...run(base[base.length - 1] + 300 + 5 * 3600, 3)]));
    expect(b.slice(0, a.length)).toEqual(a);
    expect(b).toHaveLength(2);
  });
});
