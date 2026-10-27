import { describe, expect, it } from "bun:test";
import { releaseMicrostructure, releaseReaction, type ReactionBar } from "./releaseReaction";
import type { FlowRow } from "./orderFlow";

const RELEASE = Date.parse("2026-10-28T14:30:00Z"); // 10:30 New York
const T = RELEASE / 1000;
const bar = (minute: number, o: number, h: number, l: number, c: number, volume = 10): ReactionBar => ({ time: T + minute * 60, open: o, high: h, low: l, close: c, volume });

/** 70 quiet minutes before the release at 100, then the reaction candles */
const quiet = Array.from({ length: 70 }, (_, i) => bar(i - 70, 100, 100.5, 99.5, 100, 6));

describe("releaseReaction", () => {
  it("measures every move from the close of the candle before the release, at 1, 5, 15, 30 and 60 minutes", () => {
    const after = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i / 10, 100 + i / 10 + 0.3, 100 + i / 10 - 0.1, 100 + (i + 1) / 10, 20));
    const r = releaseReaction("NYMEX:CL", [...quiet, ...after], RELEASE)!;
    expect(r.basePrice).toBe(100);
    expect(r.moves.map((m) => [m.minutes, m.price, m.change])).toEqual([[1, 100.1, 0.1], [5, 100.5, 0.5], [15, 101.5, 1.5], [30, 103, 3], [60, 106, 6]]);
    expect(r.moves[1].pct).toBeCloseTo(0.5, 2);
    expect(r.minutesCovered).toBe(60);
  });

  it("finds the widest swing either way in the first 15 minutes and which came first", () => {
    const after = [bar(0, 100, 100.2, 98.9, 99.2), bar(1, 99.2, 101.6, 99, 101.5), ...Array.from({ length: 20 }, (_, i) => bar(i + 2, 101.5, 101.6, 101.4, 101.5))];
    const r = releaseReaction("NYMEX:CL", [...quiet, ...after], RELEASE)!;
    expect(r.maxDown15).toBeCloseTo(1.1, 5);
    expect(r.maxUp15).toBeCloseTo(1.6, 5);
    expect(r.firstSwing15).toBe("down"); // the dip came in the first minute, the rally after it
  });

  it("sets the first five minutes' volume against the average five minutes of the hour before", () => {
    const after = Array.from({ length: 10 }, (_, i) => bar(i, 100, 100.1, 99.9, 100, 30));
    const r = releaseReaction("NYMEX:CL", [...quiet, ...after], RELEASE)!;
    expect(r.volumeFirst5).toBe(150);
    expect(r.volumeBefore5).toBe(30); // 6 a minute over the hour, five minutes of it
    expect(r.volumeRatio).toBe(5);
    expect(r.minutesCovered).toBe(10);
  });

  it("leaves out a move it cannot see, and the volume ratio without a quiet hour to compare with", () => {
    const r = releaseReaction("NYMEX:CL", [bar(-1, 100, 100, 100, 100), bar(0, 100, 101, 100, 101), bar(1, 101, 102, 101, 102)], RELEASE)!;
    expect(r.moves.map((m) => m.minutes)).toEqual([1]); // only the first minute has closed... and the second candle is minute 2
    expect(r.volumeBefore5).toBeUndefined();
    expect(r.volumeRatio).toBeUndefined();
  });

  it("is undefined before the release has happened, or with no history before it", () => {
    expect(releaseReaction("X", quiet, RELEASE)).toBeUndefined(); // nothing from the release on
    expect(releaseReaction("X", [bar(0, 1, 1, 1, 1)], RELEASE)).toBeUndefined(); // nothing before it
  });
});

describe("releaseMicrostructure", () => {
  const row = (secFromRelease: number, over: Partial<FlowRow> = {}): FlowRow => ({ time: RELEASE + secFromRelease * 1000, price: 100, volume: 0, bid: 99.9, ask: 100.1, bidQty: 10, askQty: 10, ...over });

  it("compares the spread before and after, notes the widest minute, and counts how busy the feed was", () => {
    const before = Array.from({ length: 50 }, (_, i) => row(-290 + i * 5, { volume: i }));
    const after = Array.from({ length: 100 }, (_, i) => row(i * 3, { bid: 99.5, ask: i < 20 ? 100.5 : 100, volume: 50 + i }));
    const m = releaseMicrostructure([...before, ...after], RELEASE)!;
    expect(m.spreadBefore).toBeCloseTo(0.2, 3);
    expect(m.spreadAfter!).toBeGreaterThan(m.spreadBefore!);
    expect(m.spreadWidest).toBeCloseTo(1, 3);
    expect(m.msgsPerMinBefore).toBe(10);
    expect(m.msgsPerMinAfter).toBe(20);
  });

  it("estimates delta from the trades after the release, and the book imbalance", () => {
    const rows: FlowRow[] = [row(-10, { volume: 100 }), ...Array.from({ length: 10 }, (_, i) => row(i * 20, { price: 100.1, volume: 110 + i * 10, depth: [{ bidQ: 30, askQ: 10 }] }))];
    const m = releaseMicrostructure(rows, RELEASE)!;
    expect(m.deltaFirst5).toBeGreaterThan(0); // every trade at the ask
    expect(m.deltaFirst15).toBeGreaterThanOrEqual(m.deltaFirst5);
    expect(m.imbalanceFirst5).toBeCloseTo(0.5, 2); // (30 - 10) / 40
  });

  it("is undefined when the feed was not recorded after the release", () => {
    expect(releaseMicrostructure([row(-30), row(-20)], RELEASE)).toBeUndefined();
    expect(releaseMicrostructure([], RELEASE)).toBeUndefined();
  });
});
