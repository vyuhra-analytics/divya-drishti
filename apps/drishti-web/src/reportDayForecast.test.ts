import { describe, expect, it } from "bun:test";
import { forecastHistory } from "./ReportDayPanel";

describe("forecastHistory", () => {
  const obs = (num: number, source: string, at: string) => ({ kind: "forecast", num, source, observedAt: at });
  it("lists every figure recorded for a release, newest first, so a change through the day is visible", () => {
    const h = forecastHistory([obs(-0.3, "Forex Factory", "2026-10-26T03:49:00Z"), obs(-0.1, "Forex Factory", "2026-10-27T15:47:00Z"), obs(0.1, "Forex Factory", "2026-10-28T02:45:00Z"), { kind: "previous", num: -3.1, source: "Forex Factory", observedAt: "2026-10-26T03:49:00Z" }]);
    expect(h.map((f) => f.value)).toEqual([0.1, -0.1, -0.3]);
  });
  it("lists a figure once when a source repeats it, keeping its newest time, and ignores figures with no number", () => {
    const h = forecastHistory([obs(0.1, "Forex Factory", "2026-10-28T02:45:00Z"), obs(0.1, "Forex Factory", "2026-10-28T05:00:00Z"), { kind: "forecast", num: null, source: "x", observedAt: "2026-10-28T06:00:00Z" }]);
    expect(h).toHaveLength(1);
    expect(h[0].at).toBe(Date.parse("2026-10-28T05:00:00Z"));
  });
});
