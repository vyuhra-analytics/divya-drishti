import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWngsrReport, parseWpsrReport, parseWpsrTable, type EiaReport } from "./eiaReport";

const fixture = (id: string): { url: string; text: string }[] => JSON.parse(readFileSync(join(import.meta.dir, `../fixtures/${id}.json`), "utf8"));

function wpsr(): EiaReport {
  const files: Record<number, string> = {};
  for (const r of fixture("eia-wpsr-tables")) {
    const m = /table(\d)\.csv/.exec(r.url);
    if (m) files[Number(m[1])] = r.text;
  }
  return parseWpsrReport(files)!;
}

const row = (r: EiaReport, id: string) => r.rows.find((x) => x.seriesId === id)!;

describe("the petroleum report, all nine tables", () => {
  const r = wpsr();

  it("reads every table of one week, each series id once", () => {
    expect(new Date(r.periodEnd).toISOString().slice(0, 10)).toBe("2026-10-16");
    expect(new Set(r.rows.map((x) => x.table)).size).toBe(9);
    expect(r.rows.length).toBeGreaterThan(150);
    expect(new Set(r.rows.map((x) => x.seriesId)).size).toBe(r.rows.length);
  });

  it("stocks (table 1): level, last week, change, year ago, and one headline", () => {
    const c = row(r, "WPSR:T1:COMMERCIAL_EXCLUDING_SPR");
    expect([c.value, c.prior, c.change, c.yearAgo, c.yearAgoPct, c.unit, c.headline]).toEqual([412.517, 415.577, -3.061, 422.824, -2.4, "million barrels", true]);
    expect(r.rows.filter((x) => x.headline)).toHaveLength(1);
    expect(row(r, "WPSR:T4:CUSHING").change).toBe(0.987);
    expect(row(r, "WPSR:T4:COMMERCIAL_EXCLUDING_SPR:GULF_COAST_PADD_3").value).toBe(229.318); // Cushing sits among the regions but is not their parent
  });

  it("refinery table (2): inputs in kb/d with the 4-week average, utilisation in percent, PADD rows under their parent", () => {
    const inputs = row(r, "WPSR:T2:REFINER_INPUTS_AND_UTILIZATION:CRUDE_OIL_INPUTS");
    expect([inputs.value, inputs.prior, inputs.change, inputs.yearAgo, inputs.avg4, inputs.unit]).toEqual([16649, 16615, 34, 15730, 16500, "kb/d"]);
    const gulf = row(r, "WPSR:T2:REFINER_INPUTS_AND_UTILIZATION:CRUDE_OIL_INPUTS:GULF_COAST_PADD_3");
    expect([gulf.value, gulf.parent]).toEqual([9406, "Crude Oil Inputs"]);
    const util = row(r, "WPSR:T2:REFINER_INPUTS_AND_UTILIZATION:PERCENT_UTILIZATION");
    expect([util.value, util.unit]).toEqual([93.4, "%"]);
    expect(row(r, "WPSR:T2:REFINER_INPUTS_AND_UTILIZATION:PERCENT_UTILIZATION:GULF_COAST_PADD_3").unit).toBe("%"); // regions of a percent row are percent too
  });

  it("table 9 has no Difference column: the change is worked out, and the 4-week figures are read", () => {
    const p = row(r, "WPSR:T9:CRUDE_OIL_PRODUCTION:DOMESTIC_PRODUCTION");
    expect([p.value, p.prior, p.change, p.yearAgo, p.avg4, p.avg4YearAgo]).toEqual([13269, 13679, -410, 13629, 13721, 13600]);
  });

  it("the weekly supply and demand block of table 1 is read with its own unit", () => {
    const supplied = r.rows.filter((x) => x.table === "T1" && x.group === "Products Supplied");
    expect(supplied.length).toBeGreaterThan(5);
    expect(new Set(supplied.map((x) => x.unit))).toEqual(new Set(["kb/d"]));
  });

  it("tables of two different weeks are never mixed", () => {
    const a = fixture("eia-wpsr-tables");
    const files: Record<number, string> = {};
    for (const x of a) files[Number(/table(\d)\.csv/.exec(x.url)![1])] = x.text;
    files[4] = files[4].replace(/10\/16\/26/g, "10/23/26");
    expect(parseWpsrReport(files)).toBeUndefined();
  });

  it("garbage and empty files give no rows", () => {
    expect(parseWpsrTable(1, "")).toEqual([]);
    expect(parseWpsrTable(2, "a,b\n1,2")).toEqual([]);
    expect(parseWpsrReport({})).toBeUndefined();
  });
});

describe("the gas storage report", () => {
  const text = fixture("eia-wngsr-csv")[0].text;
  const g = parseWngsrReport(text)!;

  it("reads the regions with last week, change, year ago and the 5-year average", () => {
    expect(g.rows.map((x) => x.label)).toEqual(["East", "Midwest", "Mountain", "Pacific", "South Central", "Salt", "Nonsalt", "Total"]);
    const t = g.rows.find((x) => x.headline)!;
    expect([t.value, t.prior, t.change, t.yearAgo, t.fiveYear, t.fiveYearPct, t.unit]).toEqual([3567, 3500, 67, 3710, 3522, 1.3, "Bcf"]);
    expect(g.rows.find((x) => x.label === "Salt")!.parent).toBe("South Central");
  });

  it("knows the official release time from the file's header line", () => {
    expect(new Date(g.releasedAt!).toISOString()).toBe("2026-10-15T14:30:00.000Z"); // 10:30 New York
  });

  it("garbage gives nothing", () => {
    expect(parseWngsrReport("")).toBeUndefined();
    expect(parseWngsrReport("Region,x\nEast,1")).toBeUndefined();
  });
});
