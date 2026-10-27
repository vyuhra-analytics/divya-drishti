import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EiaForecastsView } from "./EiaForecastsView";
import { EiaReportWidget } from "./EiaReportPanel";
import type { Widget } from "./workspace";

const empty = { forecast: undefined, actual: undefined, surprise: undefined, actualFrom: undefined };
const WED = Date.UTC(2026, 9, 21, 14, 30);
const table = {
  threshold: 3,
  rule: { threshold: 3, of: 99, reached: 53, long: 24, short: 29 },
  stats: { crude: { n: 99, bias: 0.48, meanAbs: 3.77 }, gasoline: { n: 95, bias: -0.42, meanAbs: 2.05 }, distillates: undefined, api: { n: 75, bias: 0.87, meanAbs: 4.22 } },
  releases: [
    { releaseAt: WED + 7 * 86_400_000, upcoming: true, crude: { ...empty, forecast: -0.3 }, gasoline: empty, distillates: empty, api: empty },
    { releaseAt: WED, upcoming: false, crude: { forecast: -0.1, actual: -3.06, surprise: -2.96, actualFrom: "published" }, gasoline: { forecast: -0.4, actual: -2.95, surprise: -2.55, actualFrom: "published" }, distillates: { forecast: -1.2, actual: 1.67, surprise: 2.87, actualFrom: "investing" }, api: { forecast: -1.3, actual: -4.93, surprise: -3.63, actualFrom: "investing" } },
    { releaseAt: WED - 7 * 86_400_000, upcoming: false, crude: { forecast: 0.2, actual: -8.56, surprise: -8.76, actualFrom: "published" }, gasoline: empty, distillates: empty, api: empty },
  ],
};

const urls: string[] = [];
beforeEach(() => {
  urls.length = 0;
  globalThis.fetch = mock(async (u: string) => (urls.push(String(u)), { ok: true, status: 200, json: async () => table })) as never;
});
afterEach(cleanup);

test("shows how the forecasts have done and the report-day rule's figures, then a row per release with the next one on top", async () => {
  render(<EiaForecastsView report="WPSR" active />);
  expect(await screen.findByText(/rule reached 53 of 99/)).toBeTruthy();
  expect(screen.getAllByText(/miss 3\.77/)).toHaveLength(1);
  expect(screen.getByText(/bias \+0\.48/)).toBeTruthy();
  expect(screen.getByText(/bias −?-?0\.42|bias -0\.42/)).toBeTruthy();
  expect(screen.getByText(/rule reached 53 of 99/)).toBeTruthy();
  expect(screen.getByText("24 long")).toBeTruthy();
  expect(screen.getByText("29 short")).toBeTruthy();
  expect(screen.getByText("no data")).toBeTruthy(); // distillates have no figures in this answer
  const rows = Array.from(document.querySelectorAll(".ef-table tbody tr"));
  expect(rows).toHaveLength(3);
  expect(rows[0].className).toBe("next");
  expect(rows[0].textContent).toContain("-0.30"); // the next release: its forecast and nothing else
  expect(rows[1].textContent).toContain("-3.06");
  expect(urls[0]).toContain("/eia-report/forecasts?weeks=52");
});

test("shades a crude surprise that reaches the threshold and colours it by the side the rule allows; marks an actual taken from the page", async () => {
  render(<EiaForecastsView report="WPSR" active />);
  await screen.findByText(/rule reached 53 of 99/);
  const rows = Array.from(document.querySelectorAll(".ef-table tbody tr"));
  expect(rows[1].className).toBe(""); // -2.96 is under the 3.0 threshold
  expect(rows[2].className).toBe("reached"); // -8.76 reaches it
  expect(rows[2].querySelectorAll("td")[3].className).toBe("up"); // a draw below forecast: long
  expect(rows[1].querySelectorAll("td")[3].className).toBe("");
  expect(rows[1].querySelectorAll("sup")).toHaveLength(2); // distillates and the API: figures from the page, no stored report
});

test("a different number of weeks asks for that many", async () => {
  render(<EiaForecastsView report="WPSR" active />);
  await screen.findByText(/rule reached 53 of 99/);
  fireEvent.click(screen.getByText("26 weeks"));
  await waitFor(() => expect(urls.some((u) => u.includes("weeks=26"))).toBe(true));
});

test("asks for nothing while the tab is not shown, and says so for gas, an empty store and an error", async () => {
  const { rerender } = render(<EiaForecastsView report="WPSR" active={false} />);
  expect(urls).toHaveLength(0);
  rerender(<EiaForecastsView report="WNGSR" active />);
  expect(screen.getByText(/no gas storage forecast source yet/)).toBeTruthy();
  expect(urls).toHaveLength(0);
  cleanup();
  globalThis.fetch = mock(async () => ({ ok: true, status: 200, json: async () => ({ ...table, releases: [], stats: {}, rule: undefined }) })) as never;
  render(<EiaForecastsView report="WPSR" active />);
  expect(await screen.findByText(/No forecasts stored yet/)).toBeTruthy();
  cleanup();
  globalThis.fetch = mock(async () => ({ ok: false, status: 500, json: async () => ({}) })) as never;
  render(<EiaForecastsView report="WPSR" active />);
  expect(await screen.findByText("HTTP 500")).toBeTruthy();
});

test("the EIA Report panel has a Forecasts tab", async () => {
  const widget = { id: "er", type: "eiareport", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;
  globalThis.fetch = mock(async (u: string) => (String(u).includes("/eia-report/forecasts") ? { ok: true, status: 200, json: async () => table } : { ok: false, status: 404, json: async () => ({}) })) as never;
  render(<EiaReportWidget widget={widget} />);
  fireEvent.click(screen.getByText("Petroleum (WPSR)"));
  fireEvent.click(screen.getByRole("button", { name: "Forecasts" }));
  expect(await screen.findByText(/rule reached 53 of 99/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Analysis" }));
  await waitFor(() => expect(screen.queryByText(/rule reached 53 of 99/)).toBeNull());
});
