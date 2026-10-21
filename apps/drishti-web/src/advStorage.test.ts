import { expect, test } from "bun:test";
import { sanitizeSavedState } from "./advStorage";

const saved = JSON.stringify({
  version: 1,
  symbol: "MCX:CRUDEOIL",
  exchange: "MCX",
  interval: "5m",
  chartType: "heikin-ashi",
  theme: "dark",
  chart: { version: 1, timezone: "Asia/Kolkata", viewport: { from: -247.8, to: 3 }, barSpacing: 2.9, navigation: { panEnabled: true } },
  rail: null,
});

test("a saved state keeps what the user set up but drops the old view, and takes the panel's current symbol", () => {
  const out = JSON.parse(sanitizeSavedState(saved, "MCX:NATURALGAS", "MCX"));
  expect(out.symbol).toBe("MCX:NATURALGAS");
  expect(out.chartType).toBe("heikin-ashi"); // kept
  expect(out.interval).toBe("5m"); // kept
  expect(out.chart.timezone).toBe("Asia/Kolkata"); // kept
  expect(out.chart.viewport).toBeUndefined(); // the crude-oil viewport would leave gas off screen
});

test("anything unreadable is passed through unchanged", () => {
  expect(sanitizeSavedState("not json", "MCX:CRUDEOIL", "MCX")).toBe("not json");
  expect(sanitizeSavedState('{"a":1}', "MCX:CRUDEOIL", "MCX")).toBe('{"a":1}');
});
