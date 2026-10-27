import { describe, expect, it } from "bun:test";
import { HISTORY_SERIES, type EiaReportRow } from "@drishti/shared";
import { EiaHistoryService } from "./eia-history.service";

// The history service over a fake database: how a context is built when EIA's API has not yet published the week a report covers.
const WEEK = 7 * 86_400_000;
const friday = (weeksBack: number) => new Date(Date.parse("2026-10-09T00:00:00Z") - weeksBack * WEEK).toISOString().slice(0, 10);
/** 30 weeks of crude ending 9 Oct 2026, in EIA's unit (thousand barrels), falling 1,000 a week */
const crudeRows = Array.from({ length: 30 }, (_, i) => ({ period: friday(29 - i), value: 440_000 + (29 - i) * 1000 }));

function service(published: { period: string; value: number }[] = []) {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("FROM eia_history WHERE series")) return Promise.resolve(values[0] === "WCESTUS1" ? crudeRows : []);
      if (text.includes("FROM eia_report_values v WHERE v.series_id")) return Promise.resolve(values[0] === "WPSR:T1:COMMERCIAL_EXCLUDING_SPR" ? published : []);
      return Promise.resolve([]);
    },
    {},
  );
  return new EiaHistoryService({ sql, redis: {} } as never);
}

const crudeSeries = HISTORY_SERIES.find((s) => s.key === "crude")!;
const row = (value: number): EiaReportRow => ({ seriesId: crudeSeries.seriesId, report: "WPSR", table: "T1", group: "", parent: "", label: "crude", unit: "million barrels", seq: 1, periodEnd: Date.UTC(2026, 9, 16), value, headline: true });

describe("EiaHistoryService.contexts", () => {
  it("reads a series in the report's unit (thousand barrels to million barrels)", async () => {
    const pts = await service().points(crudeSeries);
    expect(pts[pts.length - 1]).toEqual({ period: "2026-10-09", value: 440 });
  });

  it("uses the report's own figure for a week the API has not published yet, so the context is for the report's week", async () => {
    const ctx = await service().contexts("WPSR", "2026-10-16", [row(437.5)]);
    expect(ctx.crude).toMatchObject({ period: "2026-10-16", level: 437.5, change: -2.5 }); // 440 the week before
    expect(ctx.crude.streak).toEqual({ direction: "draw", weeks: 30 }); // 29 falls in the history and the new week makes it 30
  });

  it("without the report's rows a lagging history stays an earlier week, which the article then leaves out", async () => {
    const ctx = await service().contexts("WPSR", "2026-10-16");
    expect(ctx.crude.period).toBe("2026-10-09");
  });

  it("when the history already has the week, the report's figure is not used", async () => {
    const ctx = await service().contexts("WPSR", "2026-10-09", [row(999)]);
    expect(ctx.crude).toMatchObject({ period: "2026-10-09", level: 440 });
  });

  it("leaves out a series with no history at all, never guessing from the report alone", async () => {
    const ctx = await service().contexts("WPSR", "2026-10-16", [row(437.5)]);
    expect(ctx.cushing).toBeUndefined(); // the fake database holds crude only
  });
});

describe("published reports are the source of truth", () => {
  const published = [{ period: "2026-10-02", value: 441 }, { period: "2026-10-09", value: 440.2 }];

  it("the figure a stored report published wins for its week, and the API only fills the weeks without one", async () => {
    const pts = await service(published).points(crudeSeries);
    expect(pts).toHaveLength(30); // no duplicated weeks
    expect(pts.find((p) => p.period === "2026-10-09")!.value).toBe(440.2); // published, not the API's 440
    expect(pts.find((p) => p.period === "2026-09-25")!.value).toBe(442); // no stored report: the API's
  });

  it("a week stored as published extends the history past what the API has", async () => {
    const pts = await service([...published, { period: "2026-10-16", value: 437.5 }]).points(crudeSeries);
    expect(pts[pts.length - 1]).toEqual({ period: "2026-10-16", value: 437.5 });
    const ctx = await service([...published, { period: "2026-10-16", value: 437.5 }]).contexts("WPSR", "2026-10-16");
    expect(ctx.crude).toMatchObject({ period: "2026-10-16", level: 437.5 }); // no stand-in from the report rows needed
  });

  it("the cross-check lists the weeks where the published figure differs from the API's later one, and counts the rest as matching", async () => {
    const c = await service(published).crosscheck("WPSR", 26);
    expect(c).toMatchObject({ report: "WPSR", weeks: 2, compared: 2, matching: 1 });
    expect(c.revisions).toEqual([{ week: "2026-10-09", series: "crude", published: 440.2, api: 440, diff: -0.2 }]);
    expect(c.bySeries.find((s) => s.key === "crude")).toEqual({ key: "crude", compared: 2, revised: 1, maxAbsDiff: 0.2 });
  });

  it("the cross-check reads only the newest weeks asked for", async () => {
    const c = await service(published).crosscheck("WPSR", 1);
    expect(c.compared).toBe(1);
    expect(c.revisions[0].week).toBe("2026-10-09");
  });
});
