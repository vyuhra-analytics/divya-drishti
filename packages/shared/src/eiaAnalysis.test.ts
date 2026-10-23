import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWngsrReport, parseWpsrReport, type EiaReport } from "./eiaReport";
import { analyzeReport, analyzeWngsr, analyzeWpsr, RULES } from "./eiaAnalysis";

const fixture = (id: string): { url: string; text: string }[] => JSON.parse(readFileSync(join(import.meta.dir, `../fixtures/${id}.json`), "utf8"));
const files: Record<number, string> = {};
for (const r of fixture("eia-wpsr-tables")) files[Number(/table(\d)\.csv/.exec(r.url)![1])] = r.text;
const wpsr = parseWpsrReport(files)!;
const wngsr = parseWngsrReport(fixture("eia-wngsr-csv")[0].text)!;
const lines = (a: ReturnType<typeof analyzeWpsr>) => a!.sections.flatMap((s) => s.lines);
const line = (a: ReturnType<typeof analyzeWpsr>, id: string) => lines(a).find((l) => l.id === id)!;

describe("crude report analysis", () => {
  it("states the headline with its change, level and year-ago comparison", () => {
    const a = analyzeWpsr(wpsr)!;
    expect([a.headline.change, a.headline.level, a.headline.yearAgoPct, a.weekEnding]).toEqual([-3.061, 412.517, -2.4, "2026-10-16"]);
    expect(line(a, "crude-level").text).toBe("Commercial crude drew 3.061 MB to 412.5 MB, 2.4% below a year ago.");
  });

  it("the surprise rule: a draw below forecast by the threshold allows long only, a build above it short only, under it neither", () => {
    expect(analyzeWpsr(wpsr, { forecast: -1.2 })!.headline).toMatchObject({ surprise: -1.861, passes: false, side: "none" });
    expect(analyzeWpsr(wpsr, { forecast: 0.5 })!.headline).toMatchObject({ surprise: -3.561, passes: true, side: "long" });
    expect(analyzeWpsr(wpsr, { forecast: -7 })!.headline).toMatchObject({ surprise: 3.939, passes: true, side: "short" });
    expect(analyzeWpsr(wpsr, { forecast: -0.061 })!.headline).toMatchObject({ surprise: -3, passes: true, side: "long" }); // exactly the threshold counts
    expect(analyzeWpsr(wpsr)!.headline).toMatchObject({ surprise: undefined, passes: false, side: "none" }); // no forecast, no side
    expect(analyzeWpsr(wpsr)!.headline.sideText).toMatch(/No forecast/);
  });

  it("explains the week from the flows: exports, production and runs, ranked by size, with the direction each pushes stocks", () => {
    const d = line(analyzeWpsr(wpsr), "drivers").text;
    expect(d).toContain("exports -1,128 kb/d (towards a build)");
    expect(d).toContain("domestic production -410 kb/d (towards a draw)");
    expect(d.indexOf("exports")).toBeLessThan(d.indexOf("domestic production")); // biggest first
  });

  it("works days of supply and flags a product far from a year ago", () => {
    const g = line(analyzeWpsr(wpsr), "gasoline");
    expect(g.text).toContain("22.9 days of supply against 25.6 a year ago");
    expect(g.severity).toBe("flag"); // more than 10% below
    expect(line(analyzeWpsr(wpsr), "jet").severity).toBe("info");
  });

  it("checks that the parts agree: breadth across crude and products, and Cushing against the nation", () => {
    const a = analyzeWpsr(wpsr);
    expect(line(a, "breadth").text).toBe("Mixed: crude drew, gasoline drew, distillate built.");
    expect(line(a, "cushing-vs-total").text).toMatch(/Cushing built while national commercial stocks drew/);
  });

  it("every cited series exists in the report, and every line cites something", () => {
    const ids = new Set(wpsr.rows.map((r) => r.seriesId));
    for (const l of lines(analyzeWpsr(wpsr, { forecast: 0 }))) {
      expect(l.cites.length).toBeGreaterThan(0);
      for (const c of l.cites) expect([l.id, ids.has(c)]).toEqual([l.id, true]);
    }
  });

  it("leaves out what the report does not have, and gives nothing without the headline row", () => {
    const thin: EiaReport = { ...wpsr, rows: wpsr.rows.filter((r) => r.table === "T1" && r.group === "") };
    const a = analyzeWpsr(thin)!;
    expect(lines(a).map((l) => l.id)).not.toContain("drivers");
    expect(lines(a).map((l) => l.id)).toContain("crude-level");
    expect(analyzeWpsr({ ...wpsr, rows: [] })).toBeUndefined();
  });

  it("flags a large balancing adjustment and Cushing moves, from the thresholds in RULES", () => {
    const rows = wpsr.rows.map((r) => (r.seriesId === "WPSR:T1:CRUDE_OIL_SUPPLY:ADJUSTMENT" ? { ...r, value: RULES.bigAdjustmentKbd + 1 } : r.seriesId === "WPSR:T4:CUSHING" ? { ...r, change: -RULES.cushingMove } : r));
    const a = analyzeWpsr({ ...wpsr, rows })!;
    expect(line(a, "adjustment").severity).toBe("flag");
    expect(line(a, "cushing").severity).toBe("flag");
    expect(line(analyzeWpsr(wpsr), "adjustment").severity).toBe("info");
  });
});

describe("gas report analysis", () => {
  it("states the build against the 5-year average and a year ago", () => {
    const a = analyzeWngsr(wngsr)!;
    expect(line(a, "level").text).toBe("Lower 48 storage rose 67 Bcf to 3,567 Bcf.");
    expect(line(a, "five-year").text).toContain("45 Bcf above the 5-year average (3,522 Bcf, +1.3%)");
    expect(line(a, "five-year").text).toContain("143 Bcf below a year ago (-3.9%)");
  });

  it("uses the 5.0 Bcf threshold and the same side rule: storage below forecast is long", () => {
    expect(analyzeWngsr(wngsr, { forecast: 80 })!.headline).toMatchObject({ surprise: -13, passes: true, side: "long", threshold: 5 });
    expect(analyzeWngsr(wngsr, { forecast: 60 })!.headline).toMatchObject({ surprise: 7, passes: true, side: "short" });
    expect(analyzeWngsr(wngsr, { forecast: 64 })!.headline).toMatchObject({ passes: false, side: "none" });
  });

  it("ranks the regions by the week's change and by distance from the 5-year average, and separates the salt caverns", () => {
    const a = analyzeWngsr(wngsr);
    expect(line(a, "movers").text).toBe("Biggest net changes: Midwest +27 Bcf, East +22 Bcf, South Central +21 Bcf.");
    expect(line(a, "gaps").text).toContain("Pacific +6.5%");
    expect(line(a, "salt").text).toContain("salt caverns");
  });

  it("dispatches by report kind", () => {
    expect(analyzeReport(wpsr)!.report).toBe("WPSR");
    expect(analyzeReport(wngsr)!.report).toBe("WNGSR");
  });
});
