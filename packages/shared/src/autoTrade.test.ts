import { describe, expect, test } from "bun:test";
import { closedWhy, optionOrderBody, signalFresh } from "./autoTrade";
import type { OptionLegSignal } from "./optionSignal";

const leg: OptionLegSignal = { key: "MCX_FO|583810", label: "CRUDEOIL 9600 CE 2026-11-17", type: "CE", strike: 9600, expiry: "2026-11-17", units: 100, premium: 170, delta: 0.52, cost: 17000, rPremium: 15.6, rupeeR: 1560, stop: 154.4, tp1: 185.6, tp2: 201.2, trail: 10.4 };
const RELEASE = Date.parse("2026-10-29T14:30:00Z");
const ctx = { strategy: "report-day" as const, recordKey: String(RELEASE), candleTime: RELEASE / 1000 + 300, releaseAt: RELEASE };

describe("optionOrderBody", () => {
  test("report day: one lot bought, the premium stop and the TP2 target held by the server, labels for the log, and the plan (TP1 stop move, time exit)", () => {
    const b = optionOrderBody(leg, ctx);
    expect(b).toMatchObject({ option: { key: "MCX_FO|583810" }, side: "buy", lots: 1, stop: 154.4, target: 201.2, tag: "auto", strategy: "report-day", r_points: 15.6, client_order_id: `auto-${RELEASE}` });
    expect(b.signal_time).toBe(new Date(RELEASE + 600_000).toISOString()); // the signal candle's close
    expect(b.plan).toEqual({ tp1: 185.6, close_at: new Date(RELEASE + 90 * 60_000).toISOString() });
  });

  test("USIB: no target (TP2 does not close the trade); the server trails the premium after TP2 and the time stop window is its own", () => {
    const b = optionOrderBody(leg, { ...ctx, strategy: "usib", recordKey: `usib:${RELEASE}`, timeStop: { fromMin: 150, toMin: 180 } });
    expect("target" in b).toBe(false);
    expect(b.plan).toEqual({ tp1: 185.6, close_at: new Date(RELEASE + 150 * 60_000).toISOString(), tp2: 201.2, trail: 10.4, candle_sec: 300 });
    expect(b.client_order_id).toBe(`auto-usib:${RELEASE}`);
    expect("trail" in optionOrderBody({ ...leg, trail: undefined }, { ...ctx, strategy: "usib" }).plan).toBe(false);
  });

  test("the client order id is capped at 64 characters, so a retry always finds the same order", () => {
    expect(optionOrderBody(leg, { ...ctx, recordKey: "x".repeat(100) }).client_order_id).toHaveLength(64);
  });
});

describe("signalFresh and closedWhy", () => {
  test("a signal is fresh for two minutes after its candle closes", () => {
    const candle = 1_793_000_000;
    const closed = (candle + 300) * 1000;
    expect(signalFresh(candle, 300, closed + 119_000)).toBe(true);
    expect(signalFresh(candle, 300, closed + 121_000)).toBe(false);
  });

  test("the server's exit reason is told in words; a stop after TP1 is a stop at the entry", () => {
    expect(closedWhy("stop", false)).toBe("stopped out");
    expect(closedWhy("stop", true)).toBe("stopped at the entry");
    expect(closedWhy("target", false)).toBe("target (TP2)");
    expect(closedWhy("time", true)).toBe("time exit");
    expect(closedWhy("manual", false)).toBe("manual");
  });
});
