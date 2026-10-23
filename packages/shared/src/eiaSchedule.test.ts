import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CalEvent } from "./calendar";
import { applyEiaSchedule, EIA_SCHEDULE_URLS, parseEiaGasSchedule, parseEiaPetroleumSchedule, upcomingExceptions } from "./eiaSchedule";

const recorded = (url: string): string => (JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/eia-schedule.json"), "utf8")) as { url: string; text: string }[]).find((r) => r.url === url)!.text;
const wpsr = parseEiaPetroleumSchedule(recorded(EIA_SCHEDULE_URLS.WPSR));
const wngsr = parseEiaGasSchedule(recorded(EIA_SCHEDULE_URLS.WNGSR));
const iso = (ms: number) => new Date(ms).toISOString();

describe("EIA petroleum schedule (official page, recorded)", () => {
  it("reads the holiday exceptions with the week they cover, the new time and the reason", () => {
    const columbus = wpsr.find((x) => x.weekKey === "2026-10-09")!;
    expect(iso(columbus.at)).toBe("2026-10-15T16:00:00.000Z"); // Thursday 15 Oct 2026, 12:00 New York (EDT)
    expect(iso(columbus.normalAt)).toBe("2026-10-14T14:30:00.000Z"); // the Wednesday 10:30 it replaced
    expect(columbus.holiday).toBe("Columbus Day");
    expect(wpsr.find((x) => x.weekKey === "2025-12-19")).toMatchObject({ holiday: "Christmas" });
  });

  it("decodes the apostrophe in the holiday names and keeps the rows in a list", () => {
    expect(wpsr.some((x) => x.holiday === "New Year's Day")).toBe(true);
    expect(wpsr.length).toBeGreaterThan(8);
    expect(wpsr.every((x) => x.report === "WPSR" && x.at > x.normalAt)).toBe(true);
  });
});

describe("EIA gas schedule (official page, recorded)", () => {
  it("works out the Thursday each exception replaces", () => {
    const veterans = wngsr.find((x) => x.holiday === "Veterans Day" && iso(x.at).startsWith("2026"))!;
    expect(iso(veterans.at)).toBe("2026-11-13T15:30:00.000Z"); // Friday 13 Nov 2026 10:30 (EST)
    expect(iso(veterans.normalAt)).toBe("2026-11-12T15:30:00.000Z"); // the Thursday before
    expect(veterans.weekKey).toBe("2026-11-06");
    const thanks = wngsr.find((x) => iso(x.at).startsWith("2026-11-25"))!;
    expect(iso(thanks.at)).toBe("2026-11-25T17:00:00.000Z"); // Wednesday 12:00
    expect(iso(thanks.normalAt)).toBe("2026-11-26T15:30:00.000Z"); // the Thursday after (Thanksgiving)
    const christmas = wngsr.find((x) => iso(x.at).startsWith("2025-12-29"))!; // a Monday: the Thursday before
    expect(iso(christmas.normalAt)).toBe("2025-12-25T15:30:00.000Z");
  });

  it("garbage and empty pages give nothing", () => {
    for (const p of [parseEiaGasSchedule, parseEiaPetroleumSchedule]) {
      expect(p("")).toEqual([]);
      expect(p("<table><tr><td>not a date</td><td>x</td><td>y</td><td>z</td></tr></table>")).toEqual([]);
    }
  });
});

describe("applying the schedule to calendar events", () => {
  const normal = Date.UTC(2026, 9, 14, 14, 30); // Wed 14 Oct 2026 10:30 New York
  const ev = (id: string, at: number): CalEvent => ({ id: `${id}-${at}`, title: id, at, kind: "energy", impact: "high", detail: "EIA Weekly Petroleum Status Report" });

  it("moves a delayed release to the official time, tags why, and keeps one id per release", () => {
    const [moved] = applyEiaSchedule([ev("eia-oil", normal)], wpsr);
    expect(iso(moved.at)).toBe("2026-10-15T16:00:00.000Z");
    expect(moved.id).toBe(`eia-oil-${moved.at}`);
    expect(moved.delay).toEqual({ holiday: "Columbus Day", normalAt: normal });
    expect(moved.detail).toMatch(/EIA moved it for Columbus Day: normally Wed, Oct 14, 10:30 AM ET/);
  });

  it("leaves releases without an exception, other events and an empty schedule alone", () => {
    const week = ev("eia-oil", normal + 7 * 86_400_000);
    const other = ev("api", normal);
    expect(applyEiaSchedule([week, other], wpsr)).toEqual([week, other]);
    expect(applyEiaSchedule([ev("eia-oil", normal)], [])[0].delay).toBeUndefined();
  });

  it("does not apply a gas exception to a petroleum release or the other way round", () => {
    const gasThursday = Date.UTC(2026, 10, 12, 15, 30);
    expect(applyEiaSchedule([ev("eia-oil", gasThursday)], wngsr)[0].delay).toBeUndefined();
    const [g] = applyEiaSchedule([ev("eia-gas", gasThursday)], wngsr);
    expect(iso(g.at)).toBe("2026-11-13T15:30:00.000Z");
  });

  it("lists what is still ahead, soonest first", () => {
    const now = Date.UTC(2026, 9, 23);
    const next = upcomingExceptions([...wpsr, ...wngsr], now);
    expect(next[0].at).toBeGreaterThanOrEqual(now - 86_400_000);
    expect(next.map((x) => x.at)).toEqual([...next.map((x) => x.at)].sort((a, b) => a - b));
    expect(iso(next[0].at)).toBe("2026-11-12T17:00:00.000Z"); // petroleum, Veterans Day
  });
});
