import { describe, expect, it } from "bun:test";
import { gaugePosition, reviewTrade, suggestedReason, TIME_STOP, trackTrade, type ClosedTrade, type ManualTrade } from "./reportTrade";
import type { DayBar } from "./reportDay";

const REL = 1_793_000_100_000; // the print, epoch ms (a minute boundary)
const ENTER = REL + 6 * 60_000; // entered 6 minutes after the print, inside the candle that opens at +5
const ENTRY_CANDLE = (REL + 5 * 60_000) / 1000;
const candle = (n: number, high: number, low: number): DayBar => ({ time: ENTRY_CANDLE + n * 300, open: 100, high, low, close: 100 }); // n = 0 is the entry candle

const long: ManualTrade = { releaseAt: REL, enteredAt: ENTER, side: "long", futureEntry: 100, rPoints: 2, stop: 98, tp1: 102, tp2: 104, strike: 9600, premium: 200, units: 100, lots: 1, delta: 0.5, events: [] };
const short: ManualTrade = { ...long, side: "short", stop: 102, tp1: 98, tp2: 96 };
const NOW = ENTER + 20 * 60_000;

describe("trackTrade", () => {
  it("an open trade: the move and the result in R from the live price, the stop where it was", () => {
    const v = trackTrade(long, [candle(0, 105, 90)], 101, undefined, NOW);
    expect(v.status).toBe("open");
    expect(v.move).toBe(1);
    expect(v.rMultiple).toBe(0.5);
    expect(v.stop).toBe(98);
    expect(v.stopAtEntry).toBe(false);
    expect(v.events).toEqual([]); // the entry candle's own range (105 / 90) is not counted: part of it came before the entry
  });

  it("reaching TP1 moves the stop to the entry, and a later fall to the entry stops the trade there", () => {
    const up = trackTrade(long, [candle(1, 102.5, 100.5)], 101, undefined, NOW);
    expect(up.events.map((e) => e.kind)).toEqual(["tp1"]);
    expect(up.stopAtEntry).toBe(true);
    expect(up.stop).toBe(100);
    const down = trackTrade(long, [candle(1, 102.5, 100.5), candle(2, 101, 99.9)], 100, undefined, NOW);
    expect(down.events.map((e) => [e.kind, e.price])).toEqual([["tp1", 102], ["stop", 100]]);
    expect(down.status).toBe("stopped");
  });

  it("within one candle the stop is assumed first; the stop at the entry applies from the NEXT candle", () => {
    const both = trackTrade(long, [candle(1, 102.5, 97.5)], 100, undefined, NOW);
    expect(both.events.map((e) => e.kind)).toEqual(["stop"]);
    const sameCandle = trackTrade(long, [candle(1, 102.5, 99)], 101, undefined, NOW); // low 99 is above the original stop 98: TP1, and no stop in this candle
    expect(sameCandle.events.map((e) => e.kind)).toEqual(["tp1"]);
    expect(sameCandle.status).toBe("open");
  });

  it("TP2 ends the follow-up with both targets recorded", () => {
    const v = trackTrade(long, [candle(1, 104.5, 100.2), candle(2, 90, 80)], 100, undefined, NOW);
    expect(v.events.map((e) => e.kind)).toEqual(["tp1", "tp2"]);
    expect(v.status).toBe("tp2");
  });

  it("a short mirrors it", () => {
    const v = trackTrade(short, [candle(1, 99.5, 97.5)], 98.5, undefined, NOW);
    expect(v.events.map((e) => e.kind)).toEqual(["tp1"]);
    expect(v.rMultiple).toBe(0.75);
    expect(trackTrade(short, [candle(1, 102.2, 99)], 101, undefined, NOW).status).toBe("stopped");
  });

  it("the live price alone can reach a level (the candle is still forming)", () => {
    const v = trackTrade(long, [], 98, undefined, NOW);
    expect(v.status).toBe("stopped");
    expect(v.events[0]).toMatchObject({ kind: "stop", price: 98, at: NOW });
  });

  it("an event is found once: recorded events are kept and not found again", () => {
    const first = trackTrade(long, [candle(1, 102.5, 100.5)], 101, undefined, NOW);
    const again = trackTrade({ ...long, events: first.events }, [candle(1, 102.5, 100.5)], 101.5, undefined, NOW + 1000);
    expect(again.fresh).toEqual([]);
    expect(again.events).toEqual(first.events);
    expect(again.stopAtEntry).toBe(true);
  });

  it("the option's rupee result at the bid, the loss at 1R in rupees, and the cap", () => {
    // premium 200 paid, bid 190: -10 x 100 units = -1,000; 1R = 2 points x 0.5 delta x 100 = Rs 100
    const ok = trackTrade(long, [], 100, 190, NOW);
    expect(ok.pnl).toBe(-1000);
    expect(ok.rupeeR).toBe(100);
    expect(ok.capHit).toBe(false);
    const cap = trackTrade(long, [], 100, 179, NOW); // -21 x 100 = -2,100: past the Rs 2,000 cap
    expect(cap.pnl).toBe(-2100);
    expect(cap.capHit).toBe(true);
    expect(cap.fresh.map((e) => e.kind)).toContain("cap");
    expect(trackTrade(long, [], 100, undefined, NOW).pnl).toBeUndefined();
  });

  it("the time stop window opens 90 minutes after the print and closes at 120, with an event at each", () => {
    expect(TIME_STOP).toEqual({ fromMin: 90, toMin: 120 });
    expect(trackTrade(long, [], 100, undefined, REL + 89 * 60_000).timeStop.state).toBe("before");
    const w = trackTrade(long, [], 100, undefined, REL + 95 * 60_000);
    expect(w.timeStop).toEqual({ opensAt: REL + 90 * 60_000, hardAt: REL + 120 * 60_000, state: "window" });
    expect(w.events.map((e) => e.kind)).toEqual(["timestop-open"]);
    const past = trackTrade(long, [], 100, undefined, REL + 125 * 60_000);
    expect(past.timeStop.state).toBe("past");
    expect(past.events.map((e) => e.kind)).toEqual(["timestop-open", "timestop"]);
  });
});

describe("review", () => {
  const closed = (over: Partial<ClosedTrade> = {}): ClosedTrade => ({ ...long, events: [{ kind: "tp1", at: ENTER + 60_000 }], exitedAt: ENTER + 25 * 60_000, exitPremium: 230, reason: "tp1", note: "", ...over });

  it("the rupee result, the result in R, the move of the option and how long it was held", () => {
    const r = reviewTrade(closed());
    expect(r.pnl).toBe(3000); // (230 - 200) x 100
    expect(r.rResult).toBe(30); // against Rs 100 for 1R
    expect(r.optionPct).toBeCloseTo(15, 9);
    expect(r.heldMinutes).toBe(25);
    expect(r.reached).toEqual({ tp1: true, tp2: false, stop: false, cap: false });
    expect(reviewTrade(closed({ exitPremium: 150, delta: undefined })).rResult).toBeUndefined();
  });

  it("suggests the reason from what the screen saw, then the clock, else by hand", () => {
    const base = trackTrade(long, [], 100, undefined, NOW);
    expect(suggestedReason(base)).toBe("manual");
    expect(suggestedReason(trackTrade(long, [], 98, undefined, NOW))).toBe("stop");
    expect(suggestedReason(trackTrade(long, [candle(1, 104.5, 100.5)], 104, undefined, NOW))).toBe("tp2");
    expect(suggestedReason(trackTrade(long, [candle(1, 102.5, 100.5)], 101, undefined, NOW))).toBe("tp1");
    expect(suggestedReason(trackTrade(long, [], 100, 170, NOW))).toBe("cap");
    expect(suggestedReason(trackTrade(long, [], 100, undefined, REL + 100 * 60_000))).toBe("time");
  });

  it("the gauge runs from -1R at the stop to +2R at TP2, clamped", () => {
    expect(gaugePosition(-1)).toBe(0);
    expect(gaugePosition(0)).toBeCloseTo(1 / 3, 9);
    expect(gaugePosition(2)).toBe(1);
    expect(gaugePosition(-5)).toBe(0);
    expect(gaugePosition(9)).toBe(1);
  });
});
