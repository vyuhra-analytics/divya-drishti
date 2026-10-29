import { describe, expect, test } from "bun:test";
import { asManualTrade, autoSymbol, decideAuto, planAutoOrder, signalFresh, type AutoRecord } from "./autoTrade";
import { trackTrade } from "./reportTrade";

describe("planning the automatic paper trade", () => {
  test("crude trades the mini contract; levels are worked out from R at the price we trade at", () => {
    expect(autoSymbol("MCX:CRUDEOIL")).toBe("MCX:CRUDEOILM");
    expect(autoSymbol("MCX:NATGASMINI")).toBe("MCX:NATGASMINI");
    const r = planAutoOrder({ chartSymbol: "MCX:CRUDEOIL", dir: "long", ref: 9700, rPoints: 40 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan).toMatchObject({ symbol: "MCX:CRUDEOILM", side: "buy", stop: 9660, tp1: 9740, tp2: 9780, units: 10 });
    expect(r.plan.lots).toBeGreaterThanOrEqual(1);
    expect(r.plan.riskAtStop).toBeLessThanOrEqual(2000); // the loss at the stop, costs included, is inside the cap
    const s = planAutoOrder({ chartSymbol: "MCX:NATGASMINI", dir: "short", ref: 291.2, rPoints: 3 });
    if (!s.ok) throw new Error(s.reason);
    expect(s.plan).toMatchObject({ side: "sell", stop: 294.2, tp1: 288.2, tp2: 285.2 });
  });

  test("lots are whole and the cap holds; a trade that cannot fit one lot is refused with the reason", () => {
    const many = planAutoOrder({ chartSymbol: "MCX:NATGASMINI", dir: "long", ref: 290, rPoints: 1 });
    if (!many.ok) throw new Error(many.reason);
    expect(Number.isInteger(many.plan.lots)).toBe(true);
    expect(many.plan.riskAtStop).toBeLessThanOrEqual(2000);
    const big = planAutoOrder({ chartSymbol: "MCX:NATGASMINI", dir: "long", ref: 290, rPoints: 20 }); // 250 x 20 = 5,000 a lot
    expect(big).toMatchObject({ ok: false });
    expect(!big.ok && big.reason).toMatch(/over the .*2,000 cap/);
  });

  test("USIB's own TP2 is used when it lies beyond TP1, else 2R; missing inputs are refused", () => {
    const beyond = planAutoOrder({ chartSymbol: "MCX:NATGASMINI", dir: "long", ref: 290, rPoints: 3, tp2: 297 });
    expect(beyond.ok && beyond.plan.tp2).toBe(297);
    const short = planAutoOrder({ chartSymbol: "MCX:NATGASMINI", dir: "long", ref: 290, rPoints: 3, tp2: 291 }); // under TP1 (293): ignored
    expect(short.ok && short.plan.tp2).toBe(296);
    expect(planAutoOrder({ chartSymbol: "MCX:NATGASMINI", dir: "long", ref: 290 })).toMatchObject({ ok: false });
    expect(planAutoOrder({ chartSymbol: "MCX:NATGASMINI", dir: "long", ref: 0, rPoints: 3 })).toMatchObject({ ok: false });
    expect(planAutoOrder({ chartSymbol: "NYMEX:CL", dir: "long", ref: 90, rPoints: 1 })).toMatchObject({ ok: false });
  });

  test("a signal is fresh for two minutes after its candle closes", () => {
    const candle = 1_000_000; // seconds
    const closeMs = (candle + 300) * 1000;
    expect(signalFresh(candle, 300, closeMs + 119_000)).toBe(true);
    expect(signalFresh(candle, 300, closeMs + 121_000)).toBe(false);
  });
});

describe("managing the open trade", () => {
  const T0 = Date.parse("2026-10-29T14:30:00Z");
  const rec = (over: Partial<AutoRecord> = {}): AutoRecord => ({ status: "placed", symbol: "MCX:NATGASMINI", dir: "long", lots: 2, units: 250, entry: 290, stop: 287, tp1: 293, tp2: 296, rPoints: 3, enteredAt: T0 + 6 * 60_000, currentStop: 287, events: [], ...over });
  const view = (r: AutoRecord, price: number, now: number, bars = [] as { time: number; open: number; high: number; low: number; close: number }[]) => trackTrade(asManualTrade(r, T0), bars, price, undefined, now);

  test("nothing happens while the price sits between the stop and TP1", () => {
    const r = rec();
    expect(decideAuto(r, view(r, 291, T0 + 10 * 60_000))).toEqual({});
  });

  test("at TP1 the stop moves to the entry, and a stop is never loosened", () => {
    const r = rec();
    expect(decideAuto(r, view(r, 293.2, T0 + 12 * 60_000))).toEqual({ moveStop: 290 });
    const done = rec({ currentStop: 290 });
    expect(decideAuto(done, view(done, 293.2, T0 + 13 * 60_000))).toEqual({}); // already there
    const short = rec({ dir: "short", entry: 290, stop: 293, tp1: 287, tp2: 284, currentStop: 293 });
    expect(decideAuto(short, view(short, 286.8, T0 + 12 * 60_000))).toEqual({ moveStop: 290 });
  });

  test("USIB: after TP2 the stop trails under the best close, tightening only", () => {
    const r = rec({ trail: 2, events: [{ kind: "tp1", at: 1 }, { kind: "tp2", at: 2 }], currentStop: 290 });
    const bars = [{ time: Math.floor((T0 + 20 * 60_000) / 1000 / 300) * 300, open: 296, high: 298, low: 295.5, close: 297.5 }];
    expect(decideAuto(r, view(r, 297.5, T0 + 26 * 60_000, bars))).toEqual({ moveStop: 295.5 }); // best close 297.5 minus the trail of 2
  });

  test("once the time window has opened the trade is closed at the market", () => {
    const r = rec();
    expect(decideAuto(r, view(r, 291, T0 + 89 * 60_000))).toEqual({});
    expect(decideAuto(r, view(r, 291, T0 + 91 * 60_000))).toEqual({ closeTime: true });
    const usib = (now: number) => trackTrade(asManualTrade(r, T0, { fromMin: 150, toMin: 180 }), [], 291, undefined, now);
    expect(decideAuto(r, usib(T0 + 100 * 60_000))).toEqual({});
    expect(decideAuto(r, usib(T0 + 151 * 60_000))).toEqual({ closeTime: true });
  });

  test("a trade that is no longer open gets no decisions", () => {
    const r = rec({ status: "closed" });
    expect(decideAuto(r, view(r, 293.2, T0 + 95 * 60_000))).toEqual({});
  });
});
