import { describe, expect, it } from "bun:test";
import { buildForecastTable, buildGasForecastTable, type ForecastRowIn, type PublishedChange } from "./forecastTable";

const H = 3600_000;
const WED = (n: number) => Date.UTC(2026, 9, 7, 14, 30) + n * 7 * 24 * H; // Wed 7 Oct 2026 10:30 New York, then weekly
const NOW = WED(3) - 2 * 24 * H; // between the 21 Oct release (n = 2) and the 28 Oct one (n = 3)

const crude = (n: number, forecast: number | undefined, actual?: number): ForecastRowIn => ({ series: "eia_crude", releaseAt: WED(n), forecast, actual });
const rows: ForecastRowIn[] = [
  crude(0, 1.9, -3.186), crude(1, 0.2, -8.557), crude(2, -0.1, -3.06), crude(3, -0.3),
  { series: "eia_gasoline", releaseAt: WED(2), forecast: -0.4, actual: -2.952 },
  { series: "eia_distillates", releaseAt: WED(2), forecast: -1.2, actual: 1.675 },
  { series: "api_crude", releaseAt: WED(2) - 18 * H, forecast: -1.3, actual: -4.93 },
  { series: "api_crude", releaseAt: WED(3) - 18 * H, forecast: undefined, actual: undefined },
];
const published: PublishedChange[] = [{ at: WED(2), crude: -3.061, gasoline: -2.952, distillates: 1.674 }, { at: WED(1) + 90 * 60_000, crude: -8.557 }]; // a holiday week came out 90 minutes later

describe("buildForecastTable", () => {
  it("lays each release out newest first, the next release first of all with its forecast and no actual", () => {
    const t = buildForecastTable({ rows, published, now: NOW, weeks: 52 });
    expect(t.releases.map((r) => [r.releaseAt === WED(3), r.upcoming])).toEqual([[true, true], [false, false], [false, false], [false, false]]);
    expect(t.releases[0].crude).toEqual({ forecast: -0.3, actual: undefined, surprise: undefined, actualFrom: undefined });
  });

  it("works the surprise out from the PUBLISHED change when a report is stored, and from the page's own figure when not", () => {
    const t = buildForecastTable({ rows, published, now: NOW, weeks: 52 });
    const wk2 = t.releases.find((r) => r.releaseAt === WED(2))!;
    expect(wk2.crude).toEqual({ forecast: -0.1, actual: -3.06, surprise: -2.96, actualFrom: "published" }); // -3.061 published, not the page's rounder -3.06
    expect(wk2.gasoline).toEqual({ forecast: -0.4, actual: -2.95, surprise: -2.55, actualFrom: "published" });
    expect(wk2.distillates).toMatchObject({ actual: 1.67, surprise: 2.87 });
    const wk0 = t.releases.find((r) => r.releaseAt === WED(0))!;
    expect(wk0.crude).toEqual({ forecast: 1.9, actual: -3.19, surprise: -5.09, actualFrom: "investing" }); // no stored report for that week
  });

  it("matches a release that a holiday moved by hours, and the API's report as the one the day before", () => {
    const t = buildForecastTable({ rows, published, now: NOW, weeks: 52 });
    expect(t.releases.find((r) => r.releaseAt === WED(1))!.crude).toMatchObject({ actual: -8.56, actualFrom: "published" }); // published at +90 minutes
    const wk2 = t.releases.find((r) => r.releaseAt === WED(2))!;
    expect(wk2.api).toEqual({ forecast: -1.3, actual: -4.93, surprise: -3.63, actualFrom: "investing" });
    expect(t.releases[0].api).toEqual({ forecast: undefined, actual: undefined, surprise: undefined, actualFrom: undefined });
  });

  it("works out how the forecasts have done: the bias, the average miss, and how often the report-day rule reaches a side", () => {
    const t = buildForecastTable({ rows, published, now: NOW, weeks: 52, threshold: 3 });
    // crude surprises: -5.09 (week 0), -8.76 (week 1), -2.96 (week 2)
    expect(t.stats.crude).toEqual({ n: 3, bias: -5.60, meanAbs: 5.60 });
    expect(t.rule).toEqual({ threshold: 3, of: 3, reached: 2, long: 2, short: 0 }); // -2.96 stays just under the 3.0 threshold
    expect(t.stats.gasoline).toEqual({ n: 1, bias: -2.55, meanAbs: 2.55 });
    expect(t.stats.api).toEqual({ n: 1, bias: -3.63, meanAbs: 3.63 });
  });

  it("a surprise on the other side of the forecast counts for the short side, and a release with no forecast is left out of the figures", () => {
    const t = buildForecastTable({ rows: [crude(0, -1, 4.5), crude(1, undefined, 2), crude(2, 0.5, -0.1)], published: [], now: WED(2) + H, weeks: 52 });
    expect(t.rule).toEqual({ threshold: 3, of: 2, reached: 1, long: 0, short: 1 });
    expect(t.stats.crude!.n).toBe(2);
  });

  it("shows only the newest weeks asked for, and nothing for no data", () => {
    expect(buildForecastTable({ rows, published, now: NOW, weeks: 2 }).releases.filter((r) => !r.upcoming)).toHaveLength(2);
    const empty = buildForecastTable({ rows: [], published: [], now: NOW, weeks: 52 });
    expect(empty).toEqual({ releases: [], stats: { crude: undefined, gasoline: undefined, distillates: undefined, api: undefined }, rule: undefined });
  });
});

describe("buildGasForecastTable", () => {
  const rows: ForecastRowIn[] = [
    { series: "eia_gas", releaseAt: WED(1), forecast: 80, actual: 77 },
    { series: "eia_gas", releaseAt: WED(2), forecast: 76, actual: 85 },
    { series: "eia_gas", releaseAt: WED(3), forecast: 90, actual: 91 },
    { series: "eia_gas", releaseAt: WED(4), forecast: 70 },
    { series: "eia_crude", releaseAt: WED(2), forecast: 1, actual: 2 },
  ];
  const t = buildGasForecastTable({ rows, now: WED(3) + H, weeks: 52 });

  it("lists the next release first with its forecast only, then the past newest first, ignoring other series", () => {
    expect(t.releases.map((r) => [r.upcoming, r.storage.forecast, r.storage.actual, r.storage.surprise])).toEqual([
      [true, 70, undefined, undefined],
      [false, 90, 91, 1],
      [false, 76, 85, 9],
      [false, 80, 77, -3],
    ]);
    expect(t.releases[1].storage.actualFrom).toBe("investing");
  });

  it("counts the weeks the 5 Bcf rule reached and on which side: below forecast long, above short", () => {
    expect(t.rule).toEqual({ threshold: 5, of: 3, reached: 1, long: 0, short: 1 });
    expect(t.stats).toEqual({ n: 3, bias: 2.33, meanAbs: 4.33 });
  });

  it("keeps only the newest weeks asked for, and is empty without rows", () => {
    expect(buildGasForecastTable({ rows, now: WED(3) + H, weeks: 1 }).releases).toHaveLength(2);
    expect(buildGasForecastTable({ rows: [], now: WED(3), weeks: 52 })).toEqual({ releases: [], stats: undefined, rule: undefined });
  });
});
