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
