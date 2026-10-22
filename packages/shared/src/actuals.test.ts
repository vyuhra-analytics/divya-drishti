import { expect, test } from "bun:test";
import { applyEiaActuals, csvCells, fileIsForEvent, fredActual, fredSeriesFor, parseFredCsv, parseWngsr, parseWpsr, releasePending } from "./actuals";
import { energyReleases, nyTime, type CalEvent } from "./calendar";

// real excerpts of EIA's files as published on 15 Oct 2026 (week ending 9 Oct)
const wpsrCsv = `"STUB_1","10/9/26","10/2/26","Difference","Percent Change","10/10/25","Difference","Percent Change"
"Crude Oil","698.560","707.117","-8.557","-1.200","831.530","-132.969","-16.000"
"Commercial (Excluding SPR)","415.577","424.134","-8.557","-2.000","423.785","-8.207","-1.900"
"Strategic Petroleum Reserve (SPR)","282.983","282.983","0.000","0.000","407.745","-124.762","-30.600"
"Total Motor Gasoline","208.262","204.744","3.518","1.700","218.826","-10.564","-4.800"`;
const wngsrCsv = `﻿Energy Information Administration
"Working Gas in Underground Storage, Lower 48"
"Released: October 15, 2026 at 10:30 a.m. (eastern time) for the Week Ending October 9, 2026"
"Next Release: October 22, 2026"
Region,Stocks in billion (Bcf),,,,,,,,,,,,Historical Comparisons
,,,,,,,,,,,,,Year Ago (10/09/25),,,,,,5-Year (2021-25) Average
,09-Oct-26,,,02-Oct-26,,,net change (Bcf),,,implied flow (Bcf),,,stocks (Bcf),,,% change,,,stocks (Bcf),,,% change
East,"884","","","862","",,"22","",,"22",,"","880",,,"0.5",,,"856",,,"3.3",,"",""
Total,"3,567","","","3,500","",,"67","",,"67",,"","3,710",,,"-3.9",,,"3,522",,,"1.3",,"",""`;

test("csvCells keeps quoted commas together", () => {
  expect(csvCells('Total,"3,567","","",67')).toEqual(["Total", "3,567", "", "", "67"]);
});

test("parseWpsr reads the week and the change per row", () => {
  const w = parseWpsr(wpsrCsv)!;
  expect(new Date(w.weekEnding).toISOString()).toBe("2026-10-09T00:00:00.000Z");
  expect(w.change["Commercial (Excluding SPR)"]).toBe(-8.557);
  expect(w.change["Total Motor Gasoline"]).toBe(3.518);
  expect(parseWpsr("garbage")).toBeUndefined();
});

test("parseWngsr reads the week ending and the Total net change", () => {
  const g = parseWngsr(wngsrCsv)!;
  expect(new Date(g.weekEnding).toISOString()).toBe("2026-10-09T00:00:00.000Z");
  expect(g.netChange).toBe(67);
  expect(parseWngsr("nothing here")).toBeUndefined();
});

test("a weekly file only belongs to the release that follows its week", () => {
  const wed = nyTime(2026, 9, 14, 10, 30); // Wed 14 Oct, the release for the week ending Fri 9 Oct
  const nextWed = nyTime(2026, 9, 21, 10, 30);
  const week = Date.UTC(2026, 9, 9);
  expect(fileIsForEvent(week, wed)).toBe(true);
  expect(fileIsForEvent(week, nextWed)).toBe(false); // still last week's file on release morning
  expect(fileIsForEvent(Date.UTC(2026, 9, 16), nextWed)).toBe(true);
});

test("applyEiaActuals fills released EIA events from the right file and leaves the rest", () => {
  const files = { wpsr: parseWpsr(wpsrCsv)!, wngsr: parseWngsr(wngsrCsv)! };
  const ev = (key: string, at: number): CalEvent => ({ id: `${key}-${at}`, title: key, at, kind: "energy", impact: "high" });
  const oil14 = ev("eia-oil", nyTime(2026, 9, 14, 10, 30));
  const oil21 = ev("eia-oil", nyTime(2026, 9, 21, 10, 30));
  const gas15 = ev("eia-gas", nyTime(2026, 9, 15, 10, 30));
  const gas22 = ev("eia-gas", nyTime(2026, 9, 22, 10, 30));
  const rigs = ev("rigs", nyTime(2026, 9, 16, 13, 0));
  const now = nyTime(2026, 9, 21, 11, 0); // 30 minutes after the 21 Oct oil release, before the file is refreshed
  const out = applyEiaActuals([oil14, oil21, gas15, gas22, rigs], files, now);
  expect(out.map((e) => e.actual)).toEqual(["-8.6M", undefined, "67B", undefined, undefined]);
  expect(out[0].src?.actual).toBe("EIA weekly report (ir.eia.gov)"); // the actual says where it came from
  expect(out[2].src?.actual).toBe("EIA gas storage report (ir.eia.gov)");
  expect(out[1].src).toBeUndefined();
  // the file is refreshed with the next week: only then does the 21 Oct event get a number
  const next = { wpsr: { weekEnding: Date.UTC(2026, 9, 16), change: { "Commercial (Excluding SPR)": 1.234 } } };
  expect(applyEiaActuals([oil21], next, now)[0].actual).toBe("1.2M");
  expect(applyEiaActuals([ev("eia-oil", nyTime(2026, 9, 21, 10, 30))], next, nyTime(2026, 9, 21, 10, 0))[0].actual).toBeUndefined(); // not released yet
});

test("fredActual waits for the reference month and formats each kind", () => {
  const cpi = parseFredCsv("DATE,CPIAUCSL\n2025-08-01,300\n2025-09-01,301\n2026-08-01,309\n2026-09-01,310.5");
  const at = Date.UTC(2026, 9, 14, 12, 30); // CPI for September is released mid-October
  const now = at + 3600_000;
  expect(fredActual("CPI m/m", "USD", at, now, cpi)).toBe("0.5%"); // (310.5-309)/309
  expect(fredActual("CPI y/y", "USD", at, now, cpi)).toBe("3.2%"); // vs the point a year earlier (301)
  expect(fredActual("CPI m/m", "USD", at, now, cpi.slice(0, -1))).toBeUndefined(); // FRED still on August: older reading
  expect(fredActual("CPI m/m", "USD", at, at - 1, cpi)).toBeUndefined(); // not released yet
  expect(fredSeriesFor("Bank Holiday", "GBP")).toBeUndefined();
  const rate = parseFredCsv("DATE,DFEDTARU\n2026-10-13,4.50\n2026-10-14,4.25");
  expect(fredActual("Federal Funds Rate", "USD", Date.UTC(2026, 9, 14, 18), Date.UTC(2026, 9, 14, 19), rate)).toBe("4.25%");
});

test("releasePending is true while a release is due or just out without its number", () => {
  const now = nyTime(2026, 9, 21, 10, 40);
  const e = (min: number, over: Partial<CalEvent> = {}): CalEvent => ({ id: "x", title: "EIA", at: now + min * 60_000, kind: "energy", impact: "high", ...over });
  expect(releasePending([e(-10)], now)).toBe(true); // out 10 min ago, no actual yet
  expect(releasePending([e(5)], now)).toBe(true); // due in 5 min
  expect(releasePending([e(-10, { actual: "1M" })], now)).toBe(false);
  expect(releasePending([e(120)], now)).toBe(false);
  expect(releasePending([e(-60 * 7)], now)).toBe(false); // too old to keep polling for
  expect(energyReleases(now, now + 1).length).toBe(0);
});

// ---- every figure of the two EIA files, from the recorded real responses
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { wngsrPoints, wpsrPoints } from "./actuals";
const recorded = (id: string): string => JSON.parse(readFileSync(join(import.meta.dir, `../fixtures/${id}.json`), "utf8"))[0].text;

test("wpsrPoints reads every row of the stocks table with level, last week and change, flags the headline and ignores the second block", () => {
  const pts = wpsrPoints(recorded("eia-wpsr-csv"));
  expect(pts.length).toBeGreaterThanOrEqual(15);
  const by = Object.fromEntries(pts.map((p) => [p.seriesId, p]));
  expect(by["WPSR:COMMERCIAL_EXCLUDING_SPR"]).toMatchObject({ value: 415.577, prior: 424.134, change: -8.557, headline: true, unit: "million barrels", periodEnd: Date.UTC(2026, 9, 9) });
  expect(by["WPSR:CRUDE_OIL"].value).toBe(698.56);
  expect(by["WPSR:DISTILLATE_FUEL_OIL"].change).toBe(-2.527);
  expect(by["WPSR:TOTAL_STOCKS_INCLUDING_SPR"].value).toBe(1506.999); // a thousands separator is read right
  expect(pts.filter((p) => p.headline)).toHaveLength(1);
  expect(new Set(pts.map((p) => p.seriesId)).size).toBe(pts.length);
  expect(pts.some((p) => /DOMESTIC_PRODUCTION|CRUDE_OIL_SUPPLY/.test(p.seriesId))).toBe(false); // the supply and demand block is not stocks
  expect(wpsrPoints("")).toEqual([]);
  expect(wpsrPoints("garbage,1,2")).toEqual([]);
});

test("wngsrPoints reads the regions with stocks, last week's stocks and the net change, and flags the Lower 48 total", () => {
  const pts = wngsrPoints(recorded("eia-wngsr-csv"));
  const by = Object.fromEntries(pts.map((p) => [p.seriesId, p]));
  expect(pts.map((p) => p.label)).toEqual(["East", "Midwest", "Mountain", "Pacific", "South Central", "Salt", "Nonsalt", "Total"]);
  expect(by["WNGSR:TOTAL"]).toMatchObject({ value: 3567, prior: 3500, change: 67, headline: true, unit: "Bcf", periodEnd: Date.UTC(2026, 9, 9) });
  expect(by["WNGSR:SOUTH_CENTRAL"]).toMatchObject({ value: 1097, prior: 1076, change: 21 });
  expect(by["WNGSR:PACIFIC"].change).toBe(-5);
  expect(pts.filter((p) => p.headline)).toHaveLength(1);
  expect(wngsrPoints("")).toEqual([]);
  expect(wngsrPoints("Region,x\nEast,1")).toEqual([]);
});

test("the points agree with what the calendar already uses as the headline: the commercial crude change and the total gas change", () => {
  const w = parseWpsr(recorded("eia-wpsr-csv"))!;
  const wp = wpsrPoints(recorded("eia-wpsr-csv")).find((p) => p.headline)!;
  expect(wp.change).toBe(w.change["Commercial (Excluding SPR)"]);
  expect(wngsrPoints(recorded("eia-wngsr-csv")).find((p) => p.headline)!.change).toBe(parseWngsr(recorded("eia-wngsr-csv"))!.netChange);
});
