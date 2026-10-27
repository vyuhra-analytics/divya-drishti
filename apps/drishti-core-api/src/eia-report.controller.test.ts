import { describe, expect, it } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { EiaReportController } from "./eia-report.controller";

// The week picker's route over a fake store: validation first, then the stored weeks as the store gives them.
function controller(weeks: { weekEnding: string; officialReleaseAt?: number; backfilled: boolean }[] = []) {
  const asked: unknown[][] = [];
  const reports = { store: { weeks: async (...a: unknown[]) => (asked.push(a), weeks) } } as never;
  return { c: new EiaReportController(reports), asked };
}

describe("GET /eia-report/weeks", () => {
  it("returns the stored weeks of the report as the store gives them, newest first, with the default limit", async () => {
    const stored = [{ weekEnding: "2026-10-16", officialReleaseAt: 1, backfilled: true }, { weekEnding: "2026-10-09", backfilled: false }];
    const { c, asked } = controller(stored);
    expect(await c.weeks("WPSR")).toEqual(stored);
    expect(asked[0]).toEqual(["WPSR", 400]);
  });

  it("passes a limit through, and asks for the other report when asked", async () => {
    const { c, asked } = controller();
    await c.weeks("WNGSR", "52");
    expect(asked[0]).toEqual(["WNGSR", 52]);
  });

  it("refuses an unknown report and a bad limit before asking the store anything", async () => {
    const { c, asked } = controller();
    await expect(c.weeks("STEO")).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.weeks(undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.weeks("WPSR", "0")).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.weeks("WPSR", "5000")).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.weeks("WPSR", "abc")).rejects.toBeInstanceOf(BadRequestException);
    expect(asked).toHaveLength(0);
  });
});

describe("GET /eia-report/forecasts", () => {
  const withForecasts = (table: unknown) => {
    const asked: number[] = [];
    const c = new EiaReportController({ store: {} } as never, { table: async (weeks: number) => (asked.push(weeks), table) } as never);
    return { c, asked };
  };

  it("returns the forecast table of the service for the weeks asked, 52 by default", async () => {
    const table = { releases: [{ releaseAt: 1 }], stats: {}, rule: undefined, threshold: 3 };
    const { c, asked } = withForecasts(table);
    expect(await c.forecastTable()).toEqual(table as never);
    await c.forecastTable("26");
    expect(asked).toEqual([52, 26]);
  });

  it("asks the service for gas storage when the report is WNGSR, and refuses an unknown report", async () => {
    const gasAsked: number[] = [];
    const c = new EiaReportController({ store: {} } as never, { gasTable: async (w: number) => (gasAsked.push(w), { releases: [], stats: undefined, rule: undefined, threshold: 5 }) } as never);
    expect((await c.forecastTable("520", "WNGSR")) as never).toEqual({ releases: [], stats: undefined, rule: undefined, threshold: 5 } as never);
    expect(gasAsked).toEqual([520]);
    await expect(c.forecastTable("52", "STEO")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a bad number of weeks before asking the service, and answers an empty table when the forecast service is not there", async () => {
    const { c, asked } = withForecasts({});
    for (const bad of ["0", "601", "abc", "1.5"]) await expect(c.forecastTable(bad)).rejects.toBeInstanceOf(BadRequestException);
    expect(asked).toHaveLength(0);
    expect(await new EiaReportController({ store: {} } as never).forecastTable()).toEqual({ releases: [], stats: {}, rule: undefined, threshold: 3 });
  });
});

