import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReportDayWidget } from "./ReportDayPanel";
import type { Widget } from "./workspace";

const REL = Date.UTC(2026, 9, 28, 14, 30); // Wed 28 Oct 2026, 10:30 New York = 20:00 IST
const RELS = REL / 1000;
const widget = { id: "rd", type: "reportday", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;

const event = (series: string, at: number, forecast?: number) => ({ id: "1", series_code: series, scheduled_at: new Date(at).toISOString(), status: "scheduled", observations: forecast === undefined ? [] : [{ kind: "forecast", num: forecast, source: "Forex Factory", observedAt: "2026-10-27T10:00:00Z" }] });
const bar = (time: number, o: number, h: number, l: number, c: number) => ({ time, open: o, high: h, low: l, close: c, volume: 10 });
/** an hour of 5-minute candles between 100 and 110, ATR about 4 */
const hour = Array.from({ length: 12 }, (_, i) => bar(RELS - 3600 + i * 300, 105, i === 3 ? 110 : 107, i === 8 ? 100 : 103, 105));
const leg = (delta: number, ask: number) => ({ key: "k", ask, ltp: ask, delta, theta: -5, iv: 40, oi: 1000, volume: 50 });
const chain = {
  underlying: "CRUDEOIL",
  expiry: "2026-11-17",
  expiries: [],
  atm: 9600,
  lot: 100,
  updatedAt: 0,
  rows: [[9500, 0.62, 240], [9550, 0.57, 200], [9600, 0.52, 170], [9650, 0.46, 140], [9700, 0.4, 110]].map(([strike, d, ask]) => ({ strike, ce: leg(d, ask), pe: leg(-d, ask) })),
};

function serve(opts: { bars?: object[]; report?: object | null; consensus?: number | null; events?: object[] }) {
  const urls: string[] = [];
  globalThis.fetch = mock(async (u: string) => {
    const url = String(u);
    urls.push(url);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes("/calendar/stored")) return ok(url.includes("series=WPSR") ? (opts.events ?? [event("WPSR", REL)]) : []);
    if (url.includes("/eia-report/forecasts")) return ok({ releases: [{ releaseAt: REL, upcoming: true, crude: { forecast: opts.consensus ?? undefined }, storage: {} }] });
    if (url.includes("/eia-report?")) return opts.report ? ok(opts.report) : { ok: false, status: 404, json: async () => ({}) };
    if (url.includes("/bars")) return ok(opts.bars ?? hour);
    if (url.includes("/options")) return ok(chain);
    return { ok: false, status: 404, json: async () => ({}) };
  }) as never;
  return urls;
}

beforeEach(() => setSystemTime(new Date(REL - 5 * 3600_000)));
afterEach(() => {
  cleanup();
  setSystemTime();
});

test("prep: counts down to the print, shows the forecast with its source, the range start and that no side is known yet", async () => {
  serve({ consensus: -0.3 });
  render(<ReportDayWidget widget={widget} />);
  expect(await screen.findByText("Prep")).toBeTruthy();
  expect(screen.getByText(/Print in 5h 00m/)).toBeTruthy();
  const input = (await screen.findByLabelText("Forecast of the change")) as HTMLInputElement;
  await waitFor(() => expect(input.placeholder).toContain("Investing.com consensus"));
  expect(input.placeholder).toContain("-0.30");
  expect(screen.getByText("The number comes at the print.")).toBeTruthy();
  expect(screen.getByText(/The range starts at/)).toBeTruthy();
  expect(screen.queryByText(/Window: each 5-minute candle/)).toBeNull();
  await waitFor(() => expect(screen.getByText(/No side yet/)).toBeTruthy());
});

test("a forecast recorded for the release wins over the consensus, and a typed one over both", async () => {
  serve({ consensus: -0.3, events: [event("WPSR", REL, -1.2)] });
  render(<ReportDayWidget widget={widget} />);
  const input = (await screen.findByLabelText("Forecast of the change")) as HTMLInputElement;
  await waitFor(() => expect(input.placeholder).toContain("Forex Factory"));
  expect(input.placeholder).toContain("-1.20");
  fireEvent.change(input, { target: { value: "-2.5" } });
  expect(screen.queryByText(/typed in/)).toBeNull(); // the typed number is the value, not shown as a placeholder
});

test("range: the live high, low and width of the hour before the print", async () => {
  setSystemTime(new Date(REL - 20 * 60_000));
  serve({});
  render(<ReportDayWidget widget={widget} />);
  expect(await screen.findByText("Range")).toBeTruthy();
  expect(screen.getByText(/Range hour: print in 20:00/)).toBeTruthy();
  await waitFor(() => expect(document.querySelector(".rd-rangebox")?.textContent).toContain("110.0 high")); // the high of the hour
  expect(document.querySelector(".rd-rangebox")?.textContent).toContain("100.0 low");
  expect(document.querySelector(".rd-rangebox")?.textContent).toContain("width 10.0");
});

test("print and window: the number and its surprise, each candle against the range, the signal with its levels and the option to buy", async () => {
  setSystemTime(new Date(REL + 12 * 60_000)); // 12 minutes after the print: the 20:00 and 20:05 candles are closed
  const window = [bar(RELS, 105, 106, 104, 105), bar(RELS + 300, 105, 112, 104, 111), bar(RELS + 600, 111.5, 112, 110, 111.8)]; // inside, closed above, next open 111.5
  serve({
    bars: [...hour, ...window],
    consensus: -0.3,
    report: { officialReleaseAt: REL + 20_000, scheduledAt: REL, analysis: { headline: { change: -8.557, unit: "MB" } } },
  });
  render(<ReportDayWidget widget={widget} />);
  expect(await screen.findByText("Window")).toBeTruthy();
  await waitFor(() => expect(screen.getByText("-8.557")).toBeTruthy()); // the actual
  expect(screen.getByText("-8.26")).toBeTruthy(); // -8.557 minus the forecast -0.3
  expect(screen.getByText(/allows a LONG/)).toBeTruthy();
  const rows = Array.from(document.querySelectorAll(".rd-table")[0].querySelectorAll("tbody tr"));
  expect(rows).toHaveLength(3); // the third candle is still forming
  expect(rows[0].textContent).toContain("inside");
  expect(rows[1].textContent).toContain("closed above");
  expect(rows[2].textContent).toContain("forming");
  expect(screen.getByText(/SIGNAL: LONG/)).toBeTruthy();
  expect(screen.getByText("111.5")).toBeTruthy(); // the entry reference: the next open
  expect(screen.getAllByText(/1.5 × ATR/).length).toBeGreaterThan(0);
  // the option: a call, the money strike (delta 0.52), cost of one lot, and the loss at 1R checked against the cap
  await waitFor(() => expect(screen.getByText("9600 CE")).toBeTruthy());
  expect(screen.getByText(/₹17,000 for one lot/)).toBeTruthy();
  expect(screen.getByText(/1R ≈ ₹/)).toBeTruthy();
});

test("a break against the surprise is marked as skipped, and a last-week report is not taken for this release's number", async () => {
  setSystemTime(new Date(REL + 12 * 60_000));
  const down = [bar(RELS, 105, 106, 104, 105), bar(RELS + 300, 105, 106, 96, 97), bar(RELS + 600, 97, 98, 96, 97)]; // closes below the range
  serve({ bars: [...hour, ...down], consensus: -0.3, report: { officialReleaseAt: REL + 20_000, scheduledAt: REL, analysis: { headline: { change: -8.557, unit: "MB" } } } });
  render(<ReportDayWidget widget={widget} />);
  expect(await screen.findByText(/skipped: against the surprise/)).toBeTruthy(); // a long surprise, a close below
  expect(screen.queryByText(/SIGNAL/)).toBeNull();
  cleanup();
  serve({ bars: [...hour], consensus: -0.3, report: { officialReleaseAt: REL - 7 * 86_400_000, scheduledAt: REL - 7 * 86_400_000, analysis: { headline: { change: -3.06, unit: "MB" } } } });
  render(<ReportDayWidget widget={widget} />);
  await screen.findByText("Window");
  await waitFor(() => expect(screen.getByText(/Waiting for the stored report/)).toBeTruthy());
  expect(screen.queryByText("-3.060")).toBeNull();
});

test("after the cut-off: no new entries, and a window with no break says so", async () => {
  setSystemTime(new Date(REL + 40 * 60_000));
  serve({ bars: [...hour, bar(RELS, 105, 106, 104, 105), bar(RELS + 300, 105, 106, 104, 105)] });
  render(<ReportDayWidget widget={widget} />);
  expect(await screen.findByText("Entry window closed")).toBeTruthy();
  expect(await screen.findByText(/No entry: the window closed/)).toBeTruthy();
});

test("without a scheduled release it says so", async () => {
  serve({ events: [] });
  render(<ReportDayWidget widget={widget} />);
  expect(await screen.findByText(/No EIA release is scheduled/)).toBeTruthy();
});

test("the Report day desk and the RD command exist", () => {
  const { PRESETS } = require("./presets") as typeof import("./presets");
  const { MNEMONICS } = require("./command") as typeof import("./command");
  expect(PRESETS.map((p) => p.key)).toContain("reportday");
  expect(MNEMONICS.RD).toBe("reportday");
});
