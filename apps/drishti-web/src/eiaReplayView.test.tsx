import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EiaReplayView } from "./EiaReplayView";
import { BacktestWidget } from "./BacktestPanel";
import type { Widget } from "./workspace";

const REL = Date.UTC(2026, 9, 21, 14, 30);
const summary = (over: object = {}) => ({ trades: 1, winners: 0, winRate: 0, netTotal: -1049, grossTotal: -878, costsTotal: 171, avgNetR: -1.22, profitFactor: undefined, bySide: { long: { trades: 1, net: -1049 }, short: { trades: 0, net: 0 } }, skipped: { "no signal": 1, "no traded minute before the release": 2 }, ...over });
const report = {
  params: { report: "WPSR", entry: "release", underlying: "CRUDEOILM", rPct: 0.5, delayMin: 1, holdMin: 60, slip: 1, threshold: 3, since: "2026-04-25" },
  units: 10,
  rows: [
    { at: REL - 7 * 86_400_000, surprise: 1.2, result: "no signal" },
    { at: REL, surprise: -5.09, contract: "K1", result: { side: "long", entry: 8655, entryAt: 1, rPoints: 43, legs: [{ targetR: 1, exit: 8612, exitAt: 2, reason: "stop", r: -1 }, { targetR: 2, exit: 8612, exitAt: 2, reason: "stop", r: -1 }], gross: -878, costs: 171, net: -1049, netR: -1.22 } },
  ],
  summary: summary(),
  sensitivity: [{ rPct: 0.15, summary: summary({ netTotal: -400 }) }, { rPct: 0.5, summary: summary() }],
};

const urls: string[] = [];
beforeEach(() => {
  urls.length = 0;
  globalThis.fetch = mock(async (u: string) => (urls.push(String(u)), { ok: true, status: 200, json: async () => report })) as never;
});
afterEach(cleanup);

test("runs the replay with the defaults (R 0.5%) and shows the summary, the skipped releases and a row per release, newest first", async () => {
  render(<EiaReplayView />);
  fireEvent.click(screen.getByText("Run replay"));
  expect(await screen.findByText(/Only 1 trade: this cannot separate the rule from chance/)).toBeTruthy();
  expect(urls[0]).toContain("/research/eia-replay?");
  expect(urls[0]).toContain("report=WPSR");
  expect(urls[0]).toContain("rpct=0.5");
  expect(urls[0]).toContain("entry=release");
  expect(urls[0]).toContain("sensitivity=1");
  expect(screen.getByText(/2 releases skipped: no traded minute before the release/)).toBeTruthy();
  const rows = Array.from(document.querySelectorAll(".ef-table tbody tr"));
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("-5.09"); // newest first
  expect(rows[0].textContent).toContain("long");
  expect(rows[1].textContent).toContain("no signal");
  expect(screen.getByText(/How much does R matter/)).toBeTruthy();
  expect(screen.getByText(/not to pick the best R/)).toBeTruthy();
});

test("switching to the gas report sets its contract, threshold and slippage, and asks for the gas report", async () => {
  render(<EiaReplayView />);
  fireEvent.change(screen.getByLabelText("Report"), { target: { value: "WNGSR" } });
  expect((screen.getByLabelText("Contract") as HTMLSelectElement).value).toBe("NATGASMINI");
  expect((screen.getByLabelText(/Surprise at least/) as HTMLInputElement).value).toBe("5");
  expect((screen.getByLabelText(/Slippage/) as HTMLInputElement).value).toBe("0.1");
  fireEvent.click(screen.getByText("Run replay"));
  await waitFor(() => expect(urls.length).toBe(1));
  expect(urls[0]).toContain("report=WNGSR");
  expect(urls[0]).toContain("underlying=NATGASMINI");
});

test("says what the server said when it refuses", async () => {
  globalThis.fetch = mock(async () => ({ ok: false, status: 400, json: async () => ({ message: "rpct must be a number from 0.05 to 5" }) })) as never;
  render(<EiaReplayView />);
  fireEvent.click(screen.getByText("Run replay"));
  expect(await screen.findByText("rpct must be a number from 0.05 to 5")).toBeTruthy();
});

test("the Strategy tester panel offers the EIA report day beside the price strategies", () => {
  const widget = { id: "bt", type: "backtest", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;
  render(<BacktestWidget widget={widget} />);
  expect(screen.getByText("Price strategies")).toBeTruthy();
  fireEvent.click(screen.getByText("EIA report day"));
  expect(screen.getByText("Run replay")).toBeTruthy();
  fireEvent.click(screen.getByText("Price strategies"));
  expect(screen.queryByText("Run replay")).toBeNull();
});

test("the AMD entries are asked for by name and the answer says which entry it used", async () => {
  globalThis.fetch = mock(async (u: string) => (urls.push(String(u)), { ok: true, status: 200, json: async () => ({ ...report, params: { ...report.params, entry: "amd-sweep" } }) })) as never;
  render(<EiaReplayView />);
  fireEvent.change(screen.getByLabelText("Entry"), { target: { value: "amd-sweep" } });
  fireEvent.click(screen.getByText("Run replay"));
  expect(await screen.findByText(/entry AMD against the sweep/)).toBeTruthy();
  expect(urls[0]).toContain("entry=amd-sweep");
});
