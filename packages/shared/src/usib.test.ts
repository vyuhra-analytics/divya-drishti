import { describe, expect, it } from "bun:test";
import { chainLevels, pickTp2, sessionVwap, usibRange, usibStage, usOpenFor, USIB_RULES, watchUsib, type UsibBar, type ChainLevel } from "./usib";
import type { Chain } from "./options";

const utc = (iso: string) => Date.parse(iso);

describe("usOpenFor", () => {
  it("is 09:30 New York of the evening's session: 19:00 IST in summer, 20:00 IST after the clock change", () => {
    expect(usOpenFor(utc("2026-10-27T13:00:00Z"))).toBe(utc("2026-10-27T13:30:00Z")); // 18:30 IST on a Tuesday: the open is half an hour away
    expect(usOpenFor(utc("2026-11-03T14:00:00Z"))).toBe(utc("2026-11-03T14:30:00Z")); // after 1 Nov the open is 14:30 UTC = 20:00 IST
  });

  it("keeps an open for six hours, then moves to the next weekday and skips the weekend", () => {
    expect(usOpenFor(utc("2026-10-27T17:00:00Z"))).toBe(utc("2026-10-27T13:30:00Z")); // 3.5 hours after: still tonight's
    expect(usOpenFor(utc("2026-10-27T20:00:00Z"))).toBe(utc("2026-10-28T13:30:00Z")); // 6.5 hours after: tomorrow's
    expect(usOpenFor(utc("2026-10-30T21:00:00Z"))).toBe(utc("2026-11-02T14:30:00Z")); // Friday evening: Monday's, in winter time
  });
});

describe("usibStage", () => {
  it("waits, the range hour, the entry window, after", () => {
    const open = utc("2026-10-27T13:30:00Z");
    const at = (min: number) => usibStage(open + min * 60_000, open);
    expect([at(-120), at(-60), at(-1), at(0), at(59), at(60)]).toEqual(["wait", "range", "range", "watch", "watch", "after"]);
  });
});

/** 5-minute candles over the IST evening of 27 Oct 2026; the US open is 13:30 UTC = 19:00 IST. */
const OPEN = utc("2026-10-27T13:30:00Z") / 1000;
const bar = (time: number, o: number, h: number, l: number, c: number, volume = 10): UsibBar => ({ time, open: o, high: h, low: l, close: c, volume });
/** the hour before the open (12 candles) between 100 and 110, plus 12 earlier ones at volume 10 */
const before = (vol = 10): UsibBar[] => Array.from({ length: 24 }, (_, i) => bar(OPEN - 7200 + i * 300, 105, i >= 12 && i === 15 ? 110 : 107, i >= 12 && i === 20 ? 100 : 103, 105, vol));
const after = (rows: [number, number, number, number, number][]) => rows.map(([o, h, l, c, v], i) => bar(OPEN + i * 300, o, h, l, c, v));

describe("usibRange and sessionVwap", () => {
  it("the range is the high and low of the hour before the open", () => {
    expect(usibRange(before(), OPEN, OPEN + 10)).toMatchObject({ high: 110, low: 100, width: 10, candles: 12, complete: true });
    expect(usibRange([], OPEN, OPEN)).toBeUndefined();
  });

  it("VWAP is hlc3 weighted by volume and restarts at the IST day", () => {
    const a = bar(1_000_000, 10, 12, 8, 10, 1); // hlc3 10
    const b = bar(1_000_300, 10, 15, 9, 12, 3); // hlc3 12
    expect(sessionVwap([a, b])).toEqual([10, (10 * 1 + 12 * 3) / 4]);
    const nextDay = bar(1_000_000 + 86_400, 50, 50, 50, 50, 5);
    expect(sessionVwap([a, nextDay])[1]).toBe(50); // a new IST day starts again
    expect(sessionVwap([bar(5, 1, 1, 1, 1, 0)])).toEqual([null]);
  });
});

describe("chain levels and TP2", () => {
  const leg = (oi: number) => ({ key: "k", oi });
  const chain = (rows: [number, number, number][]): Chain => ({ underlying: "CRUDEOIL", expiry: "2026-11-17", expiries: [], updatedAt: 0, rows: rows.map(([strike, ce, pe]) => ({ strike, ce: leg(ce), pe: leg(pe) })) });

  it("round strikes and the three biggest open-interest walls on each side", () => {
    const lv = chainLevels(chain([[9500, 100, 5000], [9550, 90, 10], [9600, 9000, 20], [9650, 8000, 30], [9700, 7000, 40], [9750, 6000, 50], [9800, 5000, 60]]));
    expect(lv.map((l) => l.price)).toEqual([9500, 9600, 9650, 9700, 9750, 9800]); // 9550 is neither round nor a wall
    expect(lv.find((l) => l.price === 9600)?.label).toContain("call OI wall");
    expect(lv.find((l) => l.price === 9500)?.label).toContain("put OI wall"); // the biggest put wall beats being a round strike
    expect(chainLevels(null)).toEqual([]);
  });

  it("TP2 is the first level at least 0.5R beyond TP1, else 2R", () => {
    const levels: ChainLevel[] = [{ price: 102.5, label: "round strike" }, { price: 105, label: "call OI wall 9" }, { price: 108, label: "round strike" }];
    // long: entry 100, R 2, TP1 102: a level must be at or above 103; 102.5 is too close, 105 qualifies
    expect(pickTp2("long", 100, 2, 102, levels)).toEqual({ price: 105, source: "call OI wall 9" });
    expect(pickTp2("long", 100, 2, 102, [{ price: 102.5, label: "x" }]).source).toContain("2R");
    expect(pickTp2("long", 100, 2, 102, []).price).toBe(104);
    // short: entry 100, R 2, TP1 98: a level must be at or below 97
    expect(pickTp2("short", 100, 2, 98, [{ price: 97.5, label: "a" }, { price: 95, label: "b" }]).price).toBe(95);
  });
});

describe("watchUsib", () => {
  const range = { high: 110, low: 100, width: 10, candles: 12, complete: true };
  const NOW = OPEN + 30 * 60;

  it("a close above the range with 1.5x the volume and above VWAP is a signal: entry at the next open, R from the ATR, TP1, TP2 from the chain", () => {
    const bars = [...before(), ...after([[105, 106, 104, 105, 10], [105, 112, 104, 111, 20], [111.5, 112, 110, 111.8, 12]])];
    const w = watchUsib(bars, OPEN, range, [{ price: 118, label: "call OI wall 9" }], NOW);
    expect(w.candles.map((c) => c.state)).toEqual(["inside", "above", "above"]);
    expect(w.candles[1]).toMatchObject({ volumeOk: true, vwapOk: true });
    expect(w.candles[1].volumeRatio).toBeCloseTo(2, 9);
    expect(w.signal).toMatchObject({ side: "long", candleTime: OPEN + 300, entry: 111.5 });
    const s = w.signal!;
    expect(s.rPoints).toBeGreaterThan(0);
    expect(s.stop).toBeCloseTo(111.5 - s.rPoints!, 9);
    expect(s.tp1).toBeCloseTo(111.5 + s.rPoints!, 9);
    expect(s.tp2).toBeGreaterThan(s.tp1!);
    expect(s.trail).toBeCloseTo(s.atr!, 9);
  });

  it("a break that fails the volume or the VWAP filter is marked and does not use the day; the next good break is the signal", () => {
    const rows: [number, number, number, number, number][] = [[105, 112, 104, 111, 12], [111, 113, 110, 112, 25], [112, 113, 111, 112.5, 10]]; // 1.2x: filtered; 2.5x: signal
    const w = watchUsib([...before(), ...after(rows)], OPEN, range, [], NOW);
    expect(w.candles[0].filtered).toContain("volume 1.2x under 1.5x");
    expect(w.signal?.candleTime).toBe(OPEN + 300);
    // price on the wrong side of VWAP: heavy volume far above, so a close at 111 is under the session VWAP
    const heavy = before().map((b, i) => (i === 5 ? { ...b, high: 200, low: 190, close: 195, volume: 5000 } : b));
    const w2 = watchUsib([...heavy, ...after([[105, 112, 104, 111, 30]])], OPEN, range, [], NOW);
    expect(w2.candles[0].vwapOk).toBe(false);
    expect(w2.candles[0].filtered).toContain("wrong side of VWAP");
    expect(w2.signal).toBeUndefined();
  });

  it("a short mirrors it: a close below the range under VWAP", () => {
    const heavy = before().map((b, i) => (i === 5 ? { ...b, high: 120, low: 110, close: 115, volume: 5000 } : b));
    const w = watchUsib([...heavy, ...after([[105, 106, 94, 95, 30], [95, 96, 94, 95, 10]])], OPEN, range, [], NOW);
    expect(w.signal).toMatchObject({ side: "short", candleTime: OPEN, entry: 95 });
  });

  it("a candle still forming never signals, and a break after the entry window is no signal", () => {
    const forming = watchUsib([...before(), ...after([[105, 112, 104, 111, 30]])], OPEN, range, [], OPEN + 120);
    expect(forming.candles[0].complete).toBe(false);
    expect(forming.signal).toBeUndefined();
    const quiet = Array.from({ length: 13 }, () => [105, 106, 104, 105, 10] as [number, number, number, number, number]);
    const late = watchUsib([...before(), ...after([...quiet, [105, 112, 104, 111, 30]])], OPEN, range, [], OPEN + 90 * 60); // the break closes at +70 minutes
    expect(late.signal).toBeUndefined();
    expect(late.cutoffReached).toBe(true);
    expect(USIB_RULES.entryWindowMin).toBe(60);
  });

  it("is causal: a later candle never changes a signal", () => {
    const base = [...before(), ...after([[105, 106, 104, 105, 10], [105, 112, 104, 111, 20], [111.5, 112, 110, 111.8, 12]])];
    const a = watchUsib(base, OPEN, range, [], NOW);
    const b = watchUsib([...base, bar(OPEN + 900, 1, 999, 0, 1, 9999)], OPEN, range, [], NOW + 300);
    expect(b.signal).toEqual(a.signal);
  });
});
