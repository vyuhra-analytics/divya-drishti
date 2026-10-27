import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EiaArticleView } from "./EiaArticleView";
import { EiaReportWidget } from "./EiaReportPanel";
import type { Widget } from "./workspace";

const article = (title: string) => ({
  title,
  dek: "Week ending 16 Oct 2026: commercial crude stocks drew 3.06 million barrels to 412.5 million.",
  sections: [
    { heading: "The headline", paragraphs: [{ text: "Commercial crude drew 3.06 million barrels.", cites: [] }, { text: "A loose paragraph with 9.99 in it.", cites: [] }] },
    { heading: "In context", paragraphs: [{ text: "Third weekly draw in a row.", cites: [] }] },
  ],
});
const check = (wrong = 0) => ({
  total: 3,
  verified: wrong ? 1 : 2,
  wrong,
  other: [],
  paragraphs: [
    { section: 0, index: 0, verdict: wrong ? "wrong" : "verified", issues: wrong ? [{ kind: "wrong", text: "headline.change is -3.06, not -9.99." }] : [] },
    { section: 0, index: 1, verdict: "unverified", issues: [{ kind: "loose", text: "9.99 is not in the facts." }] },
    { section: 1, index: 0, verdict: "verified", issues: [] },
  ],
});

let body: unknown;
const urls: string[] = [];
beforeEach(() => {
  urls.length = 0;
  body = { report: "WPSR", weekEnding: "2026-10-16", template: { article: article("EIA petroleum report: crude draws 3.06 million barrels"), check: check(), markdown: "# EIA petroleum report\n\nbody" }, written: null };
  globalThis.fetch = mock(async (u: string) => {
    urls.push(String(u));
    return { ok: true, status: 200, json: async () => body };
  }) as never;
});
afterEach(cleanup);

test("shows the article with a verdict mark on every paragraph and says how many were checked", async () => {
  render(<EiaArticleView report="WPSR" active />);
  expect(await screen.findByText("EIA petroleum report: crude draws 3.06 million barrels")).toBeTruthy();
  expect(screen.getByText(/Week ending 16 Oct 2026/)).toBeTruthy();
  expect(screen.getAllByText("The headline")).toHaveLength(1);
  const marks = Array.from(document.querySelectorAll(".er-check")).map((m) => m.textContent);
  expect(marks).toEqual(["✓", "?", "✓"]);
  expect(screen.getByText("2 of 3 paragraphs checked")).toBeTruthy();
  expect(screen.getByTitle(/9\.99 is not in the facts/)).toBeTruthy();
  expect(urls[0]).toContain("/eia-report/article?report=WPSR");
});

test("passes a typed forecast to the article, and asks for nothing while the tab is not shown", async () => {
  const { rerender } = render(<EiaArticleView report="WNGSR" forecast={80} active={false} />);
  expect(urls).toHaveLength(0);
  rerender(<EiaArticleView report="WNGSR" forecast={80} active />);
  await waitFor(() => expect(urls[0]).toContain("report=WNGSR&forecast=80"));
});

test("the Claude version is unavailable until one exists; then it shows its own paragraphs and contradicting figures", async () => {
  render(<EiaArticleView report="WPSR" active />);
  await screen.findByText("EIA petroleum report: crude draws 3.06 million barrels");
  expect((screen.getByText(/Claude \(none yet\)/) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  body = { ...(body as object), written: { id: "ea-1", at: Date.now(), article: article("Crude stocks fall for a third week"), grounding: check(1), markdown: "# Claude version" } };
  render(<EiaArticleView report="WPSR" active />);
  await screen.findByText("EIA petroleum report: crude draws 3.06 million barrels");
  fireEvent.click(screen.getByText("Claude"));
  expect(screen.getByText("Crude stocks fall for a third week")).toBeTruthy();
  expect(screen.getByText("1 of 3 paragraphs checked, 1 contradict the data")).toBeTruthy();
  expect(Array.from(document.querySelectorAll(".er-check")).map((m) => m.textContent)).toEqual(["✗", "?", "✓"]);
  expect(screen.getByText(/Written by Claude from the app's facts/)).toBeTruthy();
});

test("copies the markdown of the version shown, and downloads it under a name with the report and the week", async () => {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (s: string) => void written.push(s) }, configurable: true });
  let name = "";
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = (() => "blob:x") as never;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    name = this.download;
  };
  render(<EiaArticleView report="WPSR" active />);
  await screen.findByText("EIA petroleum report: crude draws 3.06 million barrels");
  fireEvent.click(screen.getByText("Copy markdown"));
  await screen.findByText("Copied");
  expect(written).toEqual(["# EIA petroleum report\n\nbody"]);
  fireEvent.click(screen.getByText("Download .md"));
  expect(name).toBe("eia-wpsr-2026-10-16.md");
  URL.createObjectURL = realCreate;
  HTMLAnchorElement.prototype.click = click;
});

test("says so when no report is stored yet", async () => {
  globalThis.fetch = mock(async () => ({ ok: false, status: 404, json: async () => ({}) })) as never;
  render(<EiaArticleView report="WPSR" active />);
  expect(await screen.findByText(/No stored report yet, so no article/)).toBeTruthy();
});

test("the EIA Report panel has an Article tab that loads the article and goes back to the analysis", async () => {
  const widget = { id: "er", type: "eiareport", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;
  globalThis.fetch = mock(async (u: string) => {
    urls.push(String(u));
    if (String(u).includes("/eia-report/article")) return { ok: true, status: 200, json: async () => body };
    return { ok: false, status: 404, json: async () => ({}) };
  }) as never;
  render(<EiaReportWidget widget={widget} />);
  expect(urls.some((u) => u.includes("/eia-report/article"))).toBe(false); // not until the tab is opened
  fireEvent.click(screen.getByRole("button", { name: "Article" }));
  expect(await screen.findByText("EIA petroleum report: crude draws 3.06 million barrels")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Analysis" }));
  await waitFor(() => expect(screen.queryByText("EIA petroleum report: crude draws 3.06 million barrels")).toBeNull());
});
