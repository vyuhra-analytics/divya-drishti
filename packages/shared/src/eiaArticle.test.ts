import { describe, expect, it } from "bun:test";
import { articleMarkdown, buildArticle, buildFacts, checkArticle, citableFacts, parseArticleSubmission, type ReleaseFacts } from "./eiaArticle";
import type { EiaReport, EiaReportRow } from "./eiaReport";
import type { ReportAnalysis } from "./eiaAnalysis";
import type { SeriesContext } from "./eiaHistory";

const ctx = (over: Partial<SeriesContext> & { level: number }): SeriesContext => ({ weeks: 640, period: "2026-10-16", ...over });

/** the 16 Oct 2026 petroleum report as the stored data gave it, with a forecast and a reaction added */
const wpsrFacts = (): ReleaseFacts => ({
  report: "WPSR",
  weekEnding: "2026-10-16",
  weekText: "16 Oct 2026",
  releasedAtIso: "2026-10-21T14:30:00.000Z",
  forecast: { value: -0.1, source: "Forex Factory" },
  headline: { label: "Commercial crude stocks (excluding SPR)", unit: "MB", level: 412.5, change: -3.06, yearAgoPct: -2.4, forecast: -0.1, surprise: -2.96, threshold: 3, side: "none" },
  series: {
    crude: { unit: "MB", level: 412.5, change: -3.06, yearAgoPct: -2.4 },
    crude_total: { unit: "MB", level: 695.2, change: -3.36 },
    spr: { unit: "MB", level: 282.7, change: -0.3 },
    cushing: { unit: "MB", level: 27.6, change: 0.99 },
    exports: { unit: "kb/d", level: 3442, change: -1128, yearAgo: 4100 },
    imports: { unit: "kb/d", level: 5758, change: -291 },
    production: { unit: "kb/d", level: 13269, change: -410 },
    utilisation: { unit: "%", level: 93.4, change: -0.1 },
    runs: { unit: "kb/d", level: 16649, change: 34 },
    gasoline: { unit: "MB", level: 205.3, change: -2.95 },
    gasoline_demand: { unit: "kb/d", level: 8982, change: 575 },
    distillate: { unit: "MB", level: 104.3, change: 1.67 },
    distillate_demand: { unit: "kb/d", level: 3732, change: -591 },
    jet: { unit: "MB", level: 42.6, change: -0.19 },
    jet_demand: { unit: "kb/d", level: 1813, change: 188 },
  },
  context: {
    crude: ctx({ level: 412.5, change: -3.06, change4w: -5.4, change8w: -9.1, streak: { direction: "draw", weeks: 3 }, fiveYear: { avg: 431.2, min: 418, max: 446, years: 5, vsAvg: -18.7, vsAvgPct: -4.3, position: 0 }, seasonalChange: { avg: -1.2, years: 5 }, lowestInWeeks: 41, highestInWeeks: 1 }),
    cushing: ctx({ level: 27.6, change: 0.99, fiveYear: { avg: 31.4, min: 22, max: 40, years: 5, vsAvg: -3.8, vsAvgPct: -12.1, position: 0.31 } }),
    gasoline: ctx({ level: 205.3, fiveYear: { avg: 215.6, min: 208, max: 222, years: 5, vsAvg: -10.3, vsAvgPct: -4.8, position: 0 } }),
  },
  reaction: {
    cl: { label: "NYMEX WTI", decimals: 2, basePrice: 58.4, moves: { m1: { change: 0.21, pct: 0.36 }, m5: { change: 0.4, pct: 0.68 }, m15: { change: -0.1, pct: -0.17 }, m60: { change: 0.3, pct: 0.51 } }, maxUp15: 0.62, maxDown15: 0.2, firstSwing15: "up", high60: 0.8, low60: -0.2, volumeFirst5: 9000, volumeRatio: 4.2, minutesCovered: 60 },
    mcx_crude: { label: "MCX crude oil", decimals: 0, basePrice: 4850, moves: { m1: { change: 12, pct: 0.25 }, m5: { change: 30, pct: 0.62 } }, maxUp15: 40, maxDown15: 8, firstSwing15: "up", high60: 45, low60: -8, volumeFirst5: 800, minutesCovered: 12, micro: { spreadBefore: 1.2, spreadAfter: 2.4, spreadWidest: 4, deltaFirst5: 120, deltaFirst15: 200, msgsPerMinBefore: 20, msgsPerMinAfter: 55 } },
  },
  notes: ["The forecast is Forex Factory: a single figure, not an official consensus."],
});

describe("buildArticle (petroleum)", () => {
  it("writes the headline, the context, what moved it, the products and the reaction, and every paragraph checks against the facts", () => {
    const facts = wpsrFacts();
    const a = buildArticle(facts);
    expect(a.title).toBe("EIA petroleum report: crude draws 3.06 million barrels");
    expect(a.sections.map((s) => s.heading)).toEqual(["The headline", "In context", "What moved it", "Products", "How the market reacted", "About these figures"]);
    const text = a.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join("\n");
    expect(text).toContain("Commercial crude oil inventories drew 3.06 million barrels in the week ending 16 Oct 2026, to 412.5 million barrels, 2.4% below a year ago.");
    expect(text).toContain("third weekly draw in a row for commercial crude.");
    expect(text).toContain("18.7 million barrels (4.3%) below the five-year average for this week of 431.2, near the bottom of the five-year range");
    expect(text).toContain("lowest in 41 weeks");
    expect(text).toContain("does not reach it, so the rule allows no side");
    const check = checkArticle(a, facts);
    expect(check.wrong).toBe(0);
    const unverified = check.paragraphs.filter((p) => p.verdict !== "verified").map((p) => [a.sections[p.section].paragraphs[p.index].text.slice(0, 70), p.issues.map((i) => i.text)]);
    expect(unverified).toEqual([]);
    expect(check.verified).toBe(check.total);
    expect(check.other).toEqual([]);
  });

  it("reports the reaction of each instrument with its microstructure labelled as an estimate, and says what it cannot see", () => {
    const a = buildArticle(wpsrFacts());
    const rx = a.sections.find((s) => s.heading === "How the market reacted")!.paragraphs.map((p) => p.text).join("\n");
    expect(rx).toContain("NYMEX WTI was at 58.40 just before the release");
    expect(rx).toContain("after five minutes +0.68%");
    expect(rx).toContain("after an hour +0.51%");
    expect(rx).toContain("MCX crude oil was at 4,850 just before the release"); // a rupee price is printed whole
    expect(rx).not.toContain("after fifteen +"); // only twelve minutes are covered for it: no fifteen or sixty
    expect(rx).toContain("average bid-ask spread went from 1.20 in the five minutes before to 2.40");
    expect(rx).toContain("(an estimate)");
    expect(rx).toContain("4.2 times the average five minutes of the hour before");
  });

  it("leaves out the reaction section before the release has a reaction, and the surprise lines without a forecast", () => {
    const facts = { ...wpsrFacts(), reaction: undefined, forecast: undefined, headline: { ...wpsrFacts().headline, forecast: undefined, surprise: undefined }, notes: ["No forecast was on record for this release, so no surprise is calculated."] };
    const a = buildArticle(facts);
    expect(a.sections.map((s) => s.heading)).not.toContain("How the market reacted");
    const text = a.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join("\n");
    expect(text).toContain("No forecast was on record, so no surprise is calculated.");
    expect(text).not.toContain("report-day rule");
    expect(a.dek).toBe("Week ending 16 Oct 2026: commercial crude stocks drew 3.06 million barrels to 412.5 million.");
    expect(checkArticle(a, facts).wrong).toBe(0);
  });

  it("says why there is no reaction for an instrument whose candles were not available", () => {
    const f = buildFacts({
      report: { report: "WPSR", periodEnd: Date.UTC(2026, 9, 16), rows: [] },
      analysis: { report: "WPSR", weekEnding: "2026-10-16", headline: { label: "x", unit: "MB", level: 1, change: 1, threshold: 3, passes: false, side: "none", sideText: "" }, sections: [] } as never,
      context: {},
      reactions: { cl: { label: "NYMEX WTI", decimals: 2 } },
    });
    expect(f.reaction).toBeUndefined();
    expect(f.notes.join(" ")).toContain("No market reaction for NYMEX WTI");
  });

  it("is deterministic: the same facts give the same article", () => {
    expect(JSON.stringify(buildArticle(wpsrFacts()))).toBe(JSON.stringify(buildArticle(wpsrFacts())));
  });
});

describe("buildArticle (gas)", () => {
  const gas = (): ReleaseFacts => ({
    report: "WNGSR",
    weekEnding: "2026-10-16",
    weekText: "16 Oct 2026",
    forecast: { value: 80, source: "headline: investinglive" },
    headline: { label: "Lower 48 working gas", unit: "Bcf", level: 3644, change: 77, forecast: 80, surprise: -3, threshold: 5, side: "none" },
    series: {
      gas_total: { unit: "Bcf", level: 3644, change: 77, yearAgo: 3796, fiveYear: 3609, fiveYearPct: 1 },
      gas_east: { unit: "Bcf", level: 900, change: 16, yearAgo: 897 },
      gas_midwest: { unit: "Bcf", level: 1065, change: 28, yearAgo: 1056 },
      gas_south_central: { unit: "Bcf", level: 1125, change: 28, yearAgo: 1250 },
      gas_mountain: { unit: "Bcf", level: 257, change: 2 },
      gas_pacific: { unit: "Bcf", level: 297, change: 3 },
      gas_salt: { unit: "Bcf", level: 251, change: 15 },
    },
    context: { gas_total: ctx({ level: 3644, change: 77, streak: { direction: "build", weeks: 9 }, seasonalChange: { avg: 70, years: 5 }, fiveYear: { avg: 3609, min: 3500, max: 3700, years: 5, vsAvg: 35, vsAvgPct: 1, position: 0.72 }, lowestInWeeks: 1, highestInWeeks: 12 }) },
    notes: [],
  });

  it("writes storage against the five-year average, the seasonal norm, the regions and the salt caverns, all checked", () => {
    const facts = gas();
    const a = buildArticle(facts);
    expect(a.title).toBe("EIA gas storage: injection of 77 Bcf");
    const text = a.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join("\n");
    expect(text).toContain("rose 77 Bcf in the week ending 16 Oct 2026, to 3,644 Bcf, 1.0% above the five-year average and 3,796 Bcf a year ago");
    expect(text).toContain("The forecast on record (headline: investinglive) was +80 Bcf, a surprise of −3");
    expect(text).toContain("ninth weekly injection in a row");
    expect(text).toContain("South Central storage rose 28 Bcf to 1,125 Bcf");
    expect(text).toContain("Salt cavern storage, which can be cycled quickly, rose 15 Bcf to 251 Bcf");
    const check = checkArticle(a, facts);
    expect(check.paragraphs.filter((p) => p.verdict !== "verified").map((p) => p.issues.map((i) => i.text))).toEqual([]);
  });
});

describe("checkArticle", () => {
  it("marks a paragraph wrong when a cited value contradicts the facts, or names a field that is not there", () => {
    const facts = wpsrFacts();
    const a = buildArticle(facts);
    a.sections[0].paragraphs[0].cites[0] = { field: "headline.change", value: "-9.99" };
    a.sections[0].paragraphs[1].cites.push({ field: "series.nonsense.level", value: "1" });
    const c = checkArticle(a, facts);
    expect(c.wrong).toBe(2);
    expect(c.paragraphs[0].issues[0].text).toBe("headline.change is -3.06, not -9.99.");
  });

  it("marks a figure that is in neither the facts nor the cites as unverified, and a number with no cite at all", () => {
    const facts = wpsrFacts();
    const a = { title: "t", dek: "d", sections: [{ heading: "h", paragraphs: [{ text: "Stocks fell 7.77 million barrels.", cites: [{ field: "series.crude.level", value: "412.5" }] }, { text: "Stocks fell 3.06 million barrels.", cites: [] }] }] };
    const c = checkArticle(a, facts);
    expect(c.paragraphs[0]).toMatchObject({ verdict: "unverified" });
    expect(c.paragraphs[0].issues[0].text).toBe("7.77 is not in the facts.");
    expect(c.paragraphs[1]).toMatchObject({ verdict: "unverified" });
    expect(c.paragraphs[1].issues[0].text).toBe("Figures here cite no field.");
  });

  it("scans the title and dek too", () => {
    const facts = wpsrFacts();
    expect(checkArticle({ title: "Crude draws 42.42 million barrels", dek: "x", sections: [] }, facts).other[0].text).toBe("42.42 is not in the facts.");
  });
});

describe("buildFacts", () => {
  const row = (seriesId: string, unit: string, value: number, over: Partial<EiaReportRow> = {}): EiaReportRow => ({ seriesId, report: "WPSR", table: "T1", group: "", parent: "", label: seriesId, unit, seq: 1, periodEnd: Date.UTC(2026, 9, 16), value, headline: false, ...over });
  const report: EiaReport = { report: "WPSR", periodEnd: Date.UTC(2026, 9, 16), rows: [row("WPSR:T1:COMMERCIAL_EXCLUDING_SPR", "million barrels", 412.517, { change: -3.061, yearAgoPct: -2.43, headline: true }), row("WPSR:T1:CRUDE_OIL_SUPPLY:EXPORTS", "kb/d", 3442.4, { change: -1127.6 })] };
  const analysis = { report: "WPSR", weekEnding: "2026-10-16", headline: { label: "Commercial crude", unit: "MB", level: 412.517, change: -3.061, yearAgoPct: -2.43, forecast: -0.1, surprise: -2.961, threshold: 3, passes: false, side: "none", sideText: "" }, sections: [] } as unknown as ReportAnalysis;

  it("rounds every figure the way an article prints it, so a cited value and a printed value agree", () => {
    const f = buildFacts({ report, analysis, context: {}, forecast: { value: -0.1, source: "typed in" }, releasedAt: Date.UTC(2026, 9, 21, 14, 30), storedAt: Date.UTC(2026, 9, 21, 14, 30, 4) });
    expect(f.headline).toMatchObject({ level: 412.5, change: -3.06, yearAgoPct: -2.4, surprise: -2.96, side: "none" });
    expect(f.series.crude).toMatchObject({ level: 412.5, change: -3.06, yearAgoPct: -2.4 });
    expect(f.series.exports).toMatchObject({ level: 3442, change: -1128 });
    expect(f.storedAfterSeconds).toBe(4);
    expect(f.weekText).toBe("16 Oct 2026");
    expect(citableFacts(f)["series.crude.change"]).toBe(-3.06);
  });

  it("gives the product forecasts and the API's report as facts with each surprise worked out from the week's change, petroleum only", () => {
    const rows = [row("WPSR:T1:COMMERCIAL_EXCLUDING_SPR", "million barrels", 412.517, { change: -3.061, headline: true }), row("WPSR:T1:TOTAL_MOTOR_GASOLINE", "million barrels", 205.31, { change: -2.952 })];
    const expectations = { gasoline: -0.4, distillates: -1.2, api: { change: -4.93, forecast: -1.3, at: Date.UTC(2026, 9, 20, 20, 30) } };
    const f = buildFacts({ report: { report: "WPSR", periodEnd: Date.UTC(2026, 9, 16), rows }, analysis, context: {}, expectations });
    expect(f.expect?.gasoline).toEqual({ forecast: -0.4, surprise: -2.55 });
    expect(f.expect?.distillates).toBeUndefined(); // no distillate row in this report: nothing to compare the forecast with
    expect(f.expect?.api).toEqual({ change: -4.93, forecast: -1.3, surprise: -3.63, atIso: "2026-10-20T20:30:00.000Z" });
    expect(f.notes.join(" ")).toContain("Investing.com's consensus");
    const gas = buildFacts({ report: { ...report, report: "WNGSR" }, analysis, context: {}, expectations });
    expect(gas.expect).toBeUndefined();
  });

  it("measures our timing only for a report stored live, and notes when there was no forecast or the history lags", () => {
    const f = buildFacts({ report, analysis, context: { crude: ctx({ level: 400, period: "2026-10-09" }) }, backfilled: true, releasedAt: Date.UTC(2026, 9, 21, 14, 30), storedAt: Date.UTC(2026, 9, 23) });
    expect(f.storedAfterSeconds).toBeUndefined();
    expect(f.notes.join(" ")).toContain("No forecast was on record");
    expect(f.notes.join(" ")).toContain("had not caught up");
    expect(f.notes.join(" ")).toContain("stored after the fact");
  });

  it("leaves out the context of a series whose history ends before the report's week, instead of describing an earlier week next to this one's figures", () => {
    const f = buildFacts({ report, analysis, context: { crude: ctx({ level: 400, period: "2026-10-09", streak: { direction: "draw", weeks: 9 } }), cushing: ctx({ level: 27.6, period: "2026-10-16" }) } });
    expect(f.context.crude).toBeUndefined();
    expect(f.context.cushing).toBeDefined();
    expect(f.notes.join(" ")).toContain("had not caught up with this report for 1 series (crude), so their context is left out");
    const a = buildArticle({ ...wpsrFacts(), context: f.context });
    expect(a.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join(" ")).not.toContain("weekly draw in a row");
  });
});

describe("submission and markdown", () => {
  const good = { report: "WPSR", context_id: "ctx-1", title: "T", dek: "D", sections: [{ heading: "H", paragraphs: [{ text: "Crude drew 3.06 million barrels.", cites: [{ field: "headline.change", value: "-3.06" }] }] }] };

  it("accepts a well-formed article and refuses everything else with the reason", () => {
    expect("submission" in parseArticleSubmission(good)).toBe(true);
    const refused = (b: unknown) => (parseArticleSubmission(b) as { error: string }).error;
    expect(refused({ ...good, report: "X" })).toMatch(/report must be/);
    expect(refused({ ...good, context_id: "" })).toMatch(/context_id/);
    expect(refused({ ...good, title: "" })).toMatch(/title/);
    expect(refused({ ...good, sections: [] })).toMatch(/1 to 8/);
    expect(refused({ ...good, sections: [{ heading: "H", paragraphs: [{ text: "x".repeat(901), cites: [] }] }] })).toMatch(/text must be/);
    expect(refused({ ...good, sections: [{ heading: "H", paragraphs: [{ text: "x", cites: [{ field: "a" }] }] }] })).toMatch(/each cite needs/);
    expect(refused(null)).toMatch(/report must be/);
  });

  it("exports markdown with the headings, the paragraphs and a source line that says how much was checked", () => {
    const md = articleMarkdown({ title: "T", dek: "D", sections: [{ heading: "H", paragraphs: [{ text: "P1", cites: [] }] }] }, { source: "Written by our rules", check: { verified: 3, total: 4 } });
    expect(md).toBe("# T\n\n*D*\n\n## H\n\nP1\n\n---\n*Written by our rules · 3 of 4 paragraphs checked against the data.*");
  });
});
