import { describe, expect, it } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { EiaReplayController } from "./eia-replay.controller";
import { defaultReplay, runEiaReplay } from "./eia-replay.run";

// A fake database: tagged queries are answered by their text, sql(array) is the identity (as in Bun's driver the list is spliced into IN (...)).
const REL = Date.parse("2026-10-21T14:30:00Z");
const candle = (key: string, minute: number, o: number, h: number, l: number, c: number, volume: number) => ({ key, t: REL / 1000 + minute * 60, open: o, high: h, low: l, close: c, volume });
function fakeSql(opts: { forecasts?: object[]; candles?: object[]; changes?: object[] } = {}) {
  const asked: string[] = [];
  const fn = (strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!("raw" in strings)) return strings;
    const text = strings.join("?");
    asked.push(text);
    if (text.includes("FROM release_forecasts")) return Promise.resolve(opts.forecasts ?? []);
    if (text.includes("FROM eia_report_arrivals")) return Promise.resolve(opts.changes ?? []);
    if (text.includes("FROM option_contracts")) return Promise.resolve([{ key: "K1" }, { key: "K2" }]);
    if (text.includes("FROM option_candles")) return Promise.resolve(opts.candles ?? []);
    return Promise.resolve([]);
  };
  return { sql: fn as never, asked };
}
const draw = { release_at: new Date(REL), forecast: -0.1, actual: null }; // published change -3.06 below: surprise -2.96 under 3, so no side
const release = (forecast: number) => ({ release_at: new Date(REL), forecast, actual: null });
const changes = [{ at: new Date(REL), change: -8.5 }];

describe("runEiaReplay", () => {
  it("replays a release: surprise from the published change, the contract with the most volume BEFORE the release, a long on a big draw", async () => {
    const candles = [
      candle("K1", -5, 100, 100, 100, 100, 5), // the contract that traded more before the release wins, whatever it does after
      candle("K2", -5, 90, 90, 90, 90, 1),
      candle("K1", 1, 100, 100.4, 99.9, 100.2, 10),
      candle("K1", 2, 100.2, 101.2, 100.1, 101, 10),
      candle("K1", 3, 101, 102.6, 100.9, 102.5, 10),
      candle("K2", 3, 90, 500, 1, 90, 9999),
    ];
    const { sql } = fakeSql({ forecasts: [release(0.2)], candles, changes });
    const r = await runEiaReplay(sql, { ...defaultReplay("WPSR"), rPct: 1, slip: 0 });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].contract).toBe("K1");
    expect(r.rows[0].surprise).toBeCloseTo(-8.7);
    const t = r.rows[0].result;
    if (typeof t === "string") throw new Error(t);
    expect(t.side).toBe("long");
    expect(t.legs.map((l) => l.reason)).toEqual(["target", "target"]);
    expect(r.summary.trades).toBe(1);
    expect(r.units).toBe(10);
    expect(r.sensitivity).toBeUndefined();
  });

  it("replays the AMD entry on the same release: a spike, a displacement that leaves a gap, the retrace, and a short against the sweep", async () => {
    const m = (i: number, o: number, h: number, l: number, c: number, v = 10) => ({ key: "K1", t: REL / 1000 + i * 60, open: o, high: h, low: l, close: c, volume: v });
    const candles = [
      ...Array.from({ length: 30 }, (_, i) => m(-30 + i, 100, 100.5, 99.5, 100.1)),
      m(0, 100.1, 102, 101, 101.8),
      m(1, 101.5, 101.6, 99.0, 99.1),
      m(2, 99.1, 99.5, 98.8, 99.0),
      m(3, 99.0, 99.2, 98.9, 99.0),
      m(4, 99.0, 99.7, 98.9, 99.2),
      m(5, 99.2, 99.3, 98.6, 98.7),
      m(6, 98.7, 98.8, 98.3, 98.4),
    ];
    const { sql } = fakeSql({ forecasts: [release(0.2)], candles, changes: [{ at: new Date(REL), change: 8.5 }] }); // a build: the surprise is short
    const r = await runEiaReplay(sql, { ...defaultReplay("WPSR"), entry: "amd-sweep", rPct: 0.5, slip: 0 });
    const t = r.rows[0].result;
    if (typeof t === "string") throw new Error(t);
    expect(t.side).toBe("short");
    expect(t.entry).toBeCloseTo(99.5, 6);
    expect(defaultReplay("WPSR").entry).toBe("release");
  });

  it("skips a release with no candles, says so, and gives the sensitivity grid when asked", async () => {
    const { sql } = fakeSql({ forecasts: [release(0.2)], candles: [], changes });
    const r = await runEiaReplay(sql, defaultReplay("WPSR"), true);
    expect(r.rows[0].result).toBe("no traded minute before the release");
    expect(r.summary.skipped).toEqual({ "no traded minute before the release": 1 });
    expect(r.sensitivity?.map((s) => s.rPct)).toEqual([0.15, 0.3, 0.5, 0.75, 1]);
  });

  it("no side under the threshold", async () => {
    const { sql } = fakeSql({ forecasts: [draw], candles: [], changes: [{ at: new Date(REL), change: -3.06 }] });
    const r = await runEiaReplay(sql, defaultReplay("WPSR"));
    expect(r.rows[0].result).toBe("no signal");
  });
});

describe("GET /research/eia-replay", () => {
  const c = new EiaReplayController({ sql: fakeSql().sql } as never);

  it("answers with the default parameters of the report", async () => {
    const r = await c.replay("WNGSR");
    expect(r.params).toMatchObject({ report: "WNGSR", underlying: "NATGASMINI", rPct: 0.5, threshold: 5 });
  });

  it("refuses a bad report, underlying, number or date before touching the database", async () => {
    const asked = fakeSql();
    const ctl = new EiaReplayController({ sql: asked.sql } as never);
    await expect(ctl.replay("STEO")).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.replay("WPSR", "GOLD")).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.replay("WPSR", undefined, "9")).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.replay("WPSR", undefined, "0")).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.replay("WPSR", undefined, undefined, "99")).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.replay("WPSR", undefined, undefined, undefined, "1")).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.replay("WPSR", undefined, undefined, undefined, undefined, "-1")).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.replay("WPSR", undefined, undefined, undefined, undefined, undefined, "abc")).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.replay("WPSR", undefined, undefined, undefined, undefined, undefined, undefined, "yesterday")).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.replay("WPSR", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "market")).rejects.toBeInstanceOf(BadRequestException);
    expect(asked.asked).toHaveLength(0);
  });
});
