import { describe, expect, it } from "bun:test";
import { replayAmdTrade, replayReportTrade, reportSignal, summarizeReplay, type AmdConfig, type ReportTradeConfig } from "./eiaStrategy";
import type { Bar } from "./index";

const REL = 1_000_000 * 60; // release, epoch seconds (a minute boundary)
const bar = (m: number, o: number, h: number, l: number, c: number, v = 10): Bar => ({ time: REL + m * 60, open: o, high: h, low: l, close: c, volume: v });
const cfg: ReportTradeConfig = { rPct: 1, delayMin: 1, holdMin: 10, slip: 0, units: 10, lotsPerLeg: 1 };
const before = bar(-5, 100, 100, 100, 100); // a traded minute before the release

describe("reportSignal", () => {
  it("a draw below the forecast by the threshold is long, a build above short, anything smaller nothing", () => {
    expect(reportSignal(-3, 3)).toBe("long");
    expect(reportSignal(3.2, 3)).toBe("short");
    expect(reportSignal(-2.99, 3)).toBeUndefined();
    expect(reportSignal(undefined, 3)).toBeUndefined();
  });
});

describe("replayReportTrade", () => {
  it("enters at the open of the first traded minute and takes both targets: +1R and +2R", () => {
    const t = replayReportTrade([before, bar(1, 100, 100.5, 99.9, 100.4), bar(2, 100.4, 101.2, 100.3, 101), bar(3, 101, 102.5, 100.9, 102)], REL, "long", cfg);
    if (typeof t === "string") throw new Error(t);
    expect(t.entry).toBe(100);
    expect(t.rPoints).toBeCloseTo(1);
    expect(t.legs.map((l) => [l.targetR, l.reason, l.exit])).toEqual([[1, "target", 101], [2, "target", 102]]);
    expect(t.gross).toBeCloseTo(30); // (1 + 2) points x 10 units
    expect(t.net).toBeLessThan(t.gross);
  });

  it("within one minute the stop is assumed hit before a target", () => {
    const t = replayReportTrade([before, bar(1, 100, 101.5, 98.9, 100)], REL, "long", cfg);
    if (typeof t === "string") throw new Error(t);
    expect(t.legs.map((l) => l.reason)).toEqual(["stop", "stop"]);
    expect(t.legs[0].r).toBeCloseTo(-1);
  });

  it("a gap through the stop fills at the open, worse than the stop", () => {
    const t = replayReportTrade([before, bar(1, 100, 100.2, 99.9, 100), bar(2, 98, 98.5, 97.5, 98)], REL, "long", cfg);
    if (typeof t === "string") throw new Error(t);
    expect(t.legs[0].exit).toBe(98);
    expect(t.legs[0].r).toBeCloseTo(-2);
  });

  it("a short mirrors it, and slippage is paid on the entry and on a market exit but not on a target", () => {
    const t = replayReportTrade([before, bar(1, 100, 100.2, 99.6, 99.8), bar(2, 99.8, 99.9, 98.9, 99)], REL, "short", { ...cfg, slip: 0.1 });
    if (typeof t === "string") throw new Error(t);
    expect(t.entry).toBeCloseTo(99.9); // sold 0.1 lower
    expect(t.legs[0]).toMatchObject({ targetR: 1, reason: "target" });
    expect(t.legs[0].exit).toBeCloseTo(99.9 - 0.999);
  });

  it("a leg still open at the end of the holding time exits at the last close, against you by the slippage", () => {
    const t = replayReportTrade([before, bar(1, 100, 100.3, 99.8, 100.1), bar(2, 100.1, 100.4, 99.9, 100.2), bar(20, 100.2, 100.3, 100.1, 100.2)], REL, "long", { ...cfg, holdMin: 5, slip: 0.1 });
    if (typeof t === "string") throw new Error(t);
    expect(t.legs.every((l) => l.reason === "time")).toBe(true);
    expect(t.legs[0].exit).toBeCloseTo(100.2 - 0.1);
  });

  it("says why nothing was traded: no signal, a contract that was not trading before the release, no trade after it", () => {
    expect(replayReportTrade([before, bar(1, 100, 101, 99, 100)], REL, undefined, cfg)).toBe("no signal");
    expect(replayReportTrade([bar(-5, 100, 100, 100, 100, 0), bar(1, 100, 101, 99, 100)], REL, "long", cfg)).toBe("no traded minute before the release");
    expect(replayReportTrade([before, bar(1, 100, 100, 100, 100, 0), bar(30, 100, 101, 99, 100)], REL, "long", cfg)).toBe("no traded minute after the release");
  });

  it("is causal: a minute after the exit never changes the result", () => {
    const base = [before, bar(1, 100, 100.5, 99.9, 100.4), bar(2, 100.4, 101.2, 100.3, 101), bar(3, 101, 102.5, 100.9, 102)];
    const a = replayReportTrade(base, REL, "long", cfg);
    const b = replayReportTrade([...base, bar(4, 50, 200, 1, 3)], REL, "long", cfg);
    expect(b).toEqual(a);
  });
});

describe("summarizeReplay", () => {
  it("counts trades, wins, skips and the net by side", () => {
    const win = replayReportTrade([before, bar(1, 100, 100.5, 99.9, 100.4), bar(2, 100.4, 102.5, 100.3, 102)], REL, "long", cfg);
    const loss = replayReportTrade([before, bar(1, 100, 100.2, 98.9, 99)], REL, "short", { ...cfg, rPct: 0.5 });
    const s = summarizeReplay([win, loss, "no signal", "no signal"]);
    expect(s.trades).toBe(2);
    expect(s.skipped).toEqual({ "no signal": 2 });
    expect(s.bySide.long.trades + s.bySide.short.trades).toBe(2);
    expect(s.netTotal).toBeCloseTo(s.grossTotal - s.costsTotal);
  });
});

describe("replayAmdTrade (wait for the manipulation, enter on the retrace)", () => {
  const amd: AmdConfig = { ...cfg, rPct: 0.5, direction: "sweep" };
  const mk = (m: number, o: number, h: number, l: number, c: number, v = 10): Bar => ({ time: REL + m * 60, open: o, high: h, low: l, close: c, volume: v });
  /** 30 quiet minutes at 100 (range 99.5..100.5, bodies of 0.1) before the release */
  const pre = Array.from({ length: 30 }, (_, i) => mk(-30 + i, 100, 100.5, 99.5, 100.1));
  /** the spike up at the release (sweeps 100.5), a strong drop that leaves a gap, the retrace into it, then the move down */
  const script = [
    mk(0, 100.1, 102, 101, 101.8), // sweeps the high; low 101
    mk(1, 101.5, 101.6, 99.0, 99.1), // displacement: body 2.4, closes under the sweep bar's low 101; bar 0 low 101 > bar 2 high 99.5: a gap
    mk(2, 99.1, 99.5, 98.8, 99.0), // the third bar: its high 99.5 is the near edge of the gap
    mk(3, 99.0, 99.2, 98.9, 99.0),
    mk(4, 99.0, 99.7, 98.9, 99.2), // retrace: high 99.7 reaches 99.5, so a limit sell at 99.5 fills
    mk(5, 99.2, 99.3, 98.6, 98.7), // R = 0.5% of 99.5 = 0.4975: +1R at 99.0025 reached
    mk(6, 98.7, 98.8, 98.3, 98.4), // +2R at 98.505 reached
  ];

  it("enters short on the retrace into the gap after the spike up, with the same exits as the market entry", () => {
    const t = replayAmdTrade([...pre, ...script], REL, "short", amd);
    if (typeof t === "string") throw new Error(t);
    expect(t.side).toBe("short");
    expect(t.entry).toBeCloseTo(99.5, 6);
    expect(t.entryAt).toBe(REL + 4 * 60);
    expect(t.legs.map((l) => [l.targetR, l.reason])).toEqual([[1, "target"], [2, "target"]]);
    expect(t.rPoints).toBeCloseTo(0.4975, 6);
  });

  it("the surprise direction needs the spike to go AGAINST it: a short surprise after a spike up trades, a long surprise after a spike up does not", () => {
    const sur: AmdConfig = { ...amd, direction: "surprise" };
    expect(typeof replayAmdTrade([...pre, ...script], REL, "short", sur)).toBe("object");
    expect(replayAmdTrade([...pre, ...script], REL, "long", sur)).toBe("the spike went with the surprise: no manipulation to trade");
  });

  it("says why there was no trade: no sweep, no displacement, no retrace, no signal", () => {
    expect(replayAmdTrade([...pre, mk(0, 100, 100.2, 99.8, 100), mk(1, 100, 100.3, 99.7, 100)], REL, "short", amd)).toBe("no sweep of the pre-release range");
    const weak = [mk(0, 100.1, 102, 101, 101.8), ...Array.from({ length: 20 }, (_, i) => mk(1 + i, 101.8, 101.9, 101.7, 101.75))];
    expect(replayAmdTrade([...pre, ...weak], REL, "short", amd)).toBe("no displacement after the sweep");
    const away = [...script.slice(0, 3), ...Array.from({ length: 40 }, (_, i) => mk(3 + i, 98.5 - i * 0.1, 98.6 - i * 0.1, 98.4 - i * 0.1, 98.5 - i * 0.1))];
    expect(replayAmdTrade([...pre, ...away], REL, "short", amd)).toBe("no retrace into the gap");
    expect(replayAmdTrade([...pre, ...script], REL, undefined, amd)).toBe("no signal");
  });

  it("a bar that opens already through the limit fills at its open, not at the better level", () => {
    const gapUp = [...script.slice(0, 4), mk(4, 99.9, 100.2, 99.8, 100.0), ...script.slice(5)];
    const t = replayAmdTrade([...pre, ...gapUp], REL, "short", amd);
    if (typeof t === "string") throw new Error(t);
    expect(t.entry).toBeCloseTo(99.9, 6);
  });

  it("is causal: bars after the entry never change the entry", () => {
    const a = replayAmdTrade([...pre, ...script.slice(0, 5)], REL, "short", amd);
    const b = replayAmdTrade([...pre, ...script, mk(30, 1, 500, 0.1, 2)], REL, "short", amd);
    if (typeof a === "string" || typeof b === "string") throw new Error("expected trades");
    expect([b.entry, b.entryAt]).toEqual([a.entry, a.entryAt]);
  });
});
