import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EiaReportWidget } from "./EiaReportPanel";
import type { Widget } from "./workspace";

const widget = { id: "er", type: "eiareport", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;
const WEEKS = [
  { weekEnding: "2026-10-16", officialReleaseAt: Date.UTC(2026, 9, 21, 14, 30), backfilled: true },
  { weekEnding: "2026-10-09", officialReleaseAt: Date.UTC(2026, 9, 15, 14, 30), backfilled: true },
  { weekEnding: "2026-10-02", officialReleaseAt: Date.UTC(2026, 9, 7, 14, 30), backfilled: false },
];
const report = (weekEnding: string, change: number) => ({
  weekEnding,
  scheduledAt: Date.now(),
  officialReleaseAt: Date.UTC(2026, 9, 15, 14, 30),
  backfilled: true,
  rows: [],
  analysis: { report: "WPSR", weekEnding, headline: { label: "Commercial crude stocks (excluding SPR)", unit: "MB", level: 415.5, change, threshold: 3, passes: false, side: "none", sideText: "No forecast yet" }, sections: [] },
});

const urls: string[] = [];
beforeEach(() => {
  urls.length = 0;
  globalThis.fetch = mock(async (u: string) => {
    const url = String(u);
    urls.push(url);
    if (url.includes("/eia-report/weeks")) return { ok: true, status: 200, json: async () => WEEKS };
    if (url.includes("/eia-report/article")) return { ok: true, status: 200, json: async () => ({ weekEnding: new URL(url, "http://x").searchParams.get("week") ?? "2026-10-16", template: { article: { title: `Article for ${new URL(url, "http://x").searchParams.get("week") ?? "latest"}`, dek: "d", sections: [] }, check: { total: 0, verified: 0, wrong: 0, other: [], paragraphs: [] }, markdown: "" }, written: null }) };
    if (url.includes("/eia-report?")) {
      const week = new URL(url, "http://x").searchParams.get("week") ?? "2026-10-16";
      return { ok: true, status: 200, json: async () => report(week, week === "2026-10-09" ? -8.557 : -3.061) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as never;
});
afterEach(cleanup);

test("offers the stored weeks, newest first, with the ones stored later marked, and starts on the latest", async () => {
  render(<EiaReportWidget widget={widget} />);
  fireEvent.click(screen.getByText("Petroleum (WPSR)")); // the default report follows the weekday in New York
  await screen.findByText("Week ending 2026-10-16", { exact: false });
  await waitFor(() => expect((screen.getByLabelText("Week") as HTMLSelectElement).options.length).toBe(4));
  const options = Array.from((screen.getByLabelText("Week") as HTMLSelectElement).options).map((o) => o.textContent);
  expect(options).toEqual(["Latest (2026-10-16)", "2026-10-16 · stored later", "2026-10-09 · stored later", "2026-10-02"]);
  expect((screen.getByLabelText("Week") as HTMLSelectElement).value).toBe("");
  expect(urls.some((u) => u.includes("/eia-report?") && !u.includes("week="))).toBe(true);
});

test("picking an older week shows that week's report, and Latest brings back the newest", async () => {
  render(<EiaReportWidget widget={widget} />);
  fireEvent.click(screen.getByText("Petroleum (WPSR)"));
  await waitFor(() => expect((screen.getByLabelText("Week") as HTMLSelectElement).options.length).toBe(4));
  fireEvent.change(screen.getByLabelText("Week"), { target: { value: "2026-10-09" } });
  await screen.findByText("Week ending 2026-10-09", { exact: false });
  expect(document.querySelector(".er-big b")!.textContent).toBe("-8.557");
  expect(urls.some((u) => u.includes("/eia-report?") && u.includes("week=2026-10-09"))).toBe(true);
  fireEvent.change(screen.getByLabelText("Week"), { target: { value: "" } });
  await screen.findByText("Week ending 2026-10-16", { exact: false });
  expect(document.querySelector(".er-big b")!.textContent).toBe("-3.061");
});

test("the Article tab writes the article of the week picked", async () => {
  render(<EiaReportWidget widget={widget} />);
  fireEvent.click(screen.getByText("Petroleum (WPSR)"));
  await waitFor(() => expect((screen.getByLabelText("Week") as HTMLSelectElement).options.length).toBe(4));
  fireEvent.change(screen.getByLabelText("Week"), { target: { value: "2026-10-02" } });
  fireEvent.click(screen.getByRole("button", { name: "Article" }));
  expect(await screen.findByText("Article for 2026-10-02")).toBeTruthy();
  expect(urls.some((u) => u.includes("/eia-report/article") && u.includes("week=2026-10-02"))).toBe(true);
});

test("switching report goes back to the latest week of that report", async () => {
  render(<EiaReportWidget widget={widget} />);
  fireEvent.click(screen.getByText("Petroleum (WPSR)"));
  await waitFor(() => expect((screen.getByLabelText("Week") as HTMLSelectElement).options.length).toBe(4));
  fireEvent.change(screen.getByLabelText("Week"), { target: { value: "2026-10-09" } });
  fireEvent.click(screen.getByText("Natural gas (WNGSR)"));
  await waitFor(() => expect((screen.getByLabelText("Week") as HTMLSelectElement).value).toBe(""));
  await waitFor(() => expect(urls.some((u) => u.includes("report=WNGSR") && !u.includes("week="))).toBe(true));
});

test("a weeks answer that is not a list leaves just Latest, instead of breaking the panel", async () => {
  globalThis.fetch = mock(async (u: string) => (String(u).includes("/eia-report/weeks") ? { ok: true, status: 200, json: async () => ({ not: "a list" }) } : { ok: true, status: 200, json: async () => report("2026-10-16", -3.061) })) as never;
  render(<EiaReportWidget widget={widget} />);
  fireEvent.click(screen.getByText("Petroleum (WPSR)"));
  await screen.findByText("Week ending 2026-10-16", { exact: false });
  expect((screen.getByLabelText("Week") as HTMLSelectElement).options.length).toBe(1);
});
