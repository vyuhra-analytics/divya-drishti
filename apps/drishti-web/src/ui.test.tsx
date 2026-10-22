import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { NewsItem } from "@drishti/shared";
import { PanelBoundary } from "./PanelBoundary";
import { NewsWidget } from "./NewsWidget";
import { Palette } from "./Palette";
import { useStore } from "./store";
import { useWorkspace, type Widget } from "./workspace";

const widget = (type: Widget["type"]): Widget => ({ id: `w-${type}`, type, symbol: "CRUDEOIL", group: null }) as Widget;

beforeEach(() => {
  useStore.setState({ news: [], quotes: {} });
});
afterEach(cleanup);

test("PanelBoundary shows the error with Retry, and recovers", () => {
  let broken = true;
  const Bomb = () => {
    if (broken) throw new Error("boom");
    return <p>fine</p>;
  };
  const err = console.error;
  console.error = () => {}; // React logs the caught render error
  render(
    <PanelBoundary title="Chart">
      <Bomb />
    </PanelBoundary>,
  );
  expect(screen.getByRole("alert").textContent).toContain("Chart stopped working");
  broken = false;
  fireEvent.click(screen.getByText("Retry"));
  expect(screen.getByText("fine")).toBeTruthy();
  console.error = err;
});

const story = (id: string, title: string, tags: NewsItem["tags"], source = "Reuters"): NewsItem => ({ id, title, url: "https://x.test/" + id, source, publishedAt: Date.now() - 60_000, tags });

test("NewsWidget filters by tag and by search text", () => {
  useStore.setState({
    news: [story("a", "Brent crude slips", ["crude"]), story("b", "Henry Hub gas climbs", ["natgas"], "Bloomberg"), story("c", "ONGC profit rises", ["india"])],
  });
  render(<NewsWidget widget={widget("news")} />);
  fireEvent.click(screen.getByText("All"));
  expect(screen.getAllByRole("link")).toHaveLength(3);
  fireEvent.click(screen.getByText("Nat Gas"));
  expect(screen.getByText("Henry Hub gas climbs")).toBeTruthy();
  expect(screen.queryByText("Brent crude slips")).toBeNull();
  fireEvent.click(screen.getByText("All"));
  fireEvent.change(screen.getByLabelText("Search headlines"), { target: { value: "bloomberg" } });
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByText("Henry Hub gas climbs")).toBeTruthy();
});

test("Palette runs a command and closes", () => {
  useWorkspace.getState().setPaletteOpen(true);
  const before = useWorkspace.getState().widgets.length;
  render(<Palette />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "CAL" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(useWorkspace.getState().widgets.length).toBe(before + 1);
  expect(useWorkspace.getState().paletteOpen).toBe(false);
});

const mockFetch = (body: unknown, ok = true) => {
  globalThis.fetch = mock(async () => ({ ok, status: ok ? 200 : 503, json: async () => body })) as never;
};

test("Settings clock toggle switches stamps between 12h and 24h", () => {
  const t = Date.UTC(2026, 9, 21, 15, 42); // 21:12 IST
  const { useSettings, formatStamp } = require("./settings") as typeof import("./settings");
  useSettings.setState({ clock: "24h" });
  expect(formatStamp(t, "en-IN", useSettings.getState().clock, "time", "Asia/Kolkata")).toContain("21:12");
  useSettings.setState({ clock: "12h" });
  expect(formatStamp(t, "en-IN", useSettings.getState().clock, "time", "Asia/Kolkata").toLowerCase()).toMatch(/9:12\s?pm/);
});

test("Quote and Watchlist panels render with no data and with a live quote", () => {
  const { WIDGETS } = require("./widgets") as typeof import("./widgets");
  const QuoteWidget = WIDGETS.quote.component;
  const WatchlistWidget = WIDGETS.watchlist.component;
  render(<QuoteWidget widget={widget("quote")} />);
  cleanup();
  useStore.setState({
    quotes: { CRUDEOIL: { symbol: "CRUDEOIL", price: 9123, prevClose: 9000, time: Date.now(), delayedBy: 0, source: "upstox", bid: 9122, ask: 9124, bidQty: 5, askQty: 7, oi: 1234 } as never },
  });
  render(<QuoteWidget widget={widget("quote")} />);
  expect(document.body.textContent).toContain("9,123");
  cleanup();
  render(<WatchlistWidget widget={widget("watchlist")} />);
  expect(document.body.textContent).toContain("CRUDEOIL");
});

test("CalendarWidget shows forecast, previous and actual per event, and filters by kind", async () => {
  const at = Date.now() + 3600_000;
  mockFetch([
    { id: "e1", title: "EIA crude inventories", at, kind: "energy", impact: "high", forecast: "-1M", previous: "2M" },
    { id: "e0", title: "EIA natural gas storage", at: Date.now() - 600_000, kind: "energy", impact: "high", forecast: "83B", previous: "67B", actual: "90B" },
    { id: "h1", title: "MCX closed: Diwali", at: at + 86_400_000, kind: "holiday", impact: "medium" },
  ]);
  const { CalendarWidget } = require("./CalendarPanel") as typeof import("./CalendarPanel");
  render(<CalendarWidget widget={widget("calendar")} />);
  expect(await screen.findByText("EIA crude inventories")).toBeTruthy();
  const upcoming = screen.getByText("EIA crude inventories").closest(".cal-row")!;
  expect(upcoming.querySelector(".cal-fc")!.textContent).toBe("-1M");
  expect(upcoming.querySelector(".cal-prev")!.textContent).toBe("2M");
  expect(upcoming.querySelector(".cal-actual")!.textContent).toBe(""); // not out yet
  const released = screen.getByText("EIA natural gas storage").closest(".cal-row")!;
  expect(released.querySelector(".cal-actual")!.textContent).toBe("90B");
  expect(released.querySelector(".cal-actual")!.className).toContain("up"); // above the 83B forecast
  fireEvent.click(upcoming.querySelector(".cal-bell")!); // bell: an alert 15 minutes before this release
  const { useAlerts } = require("./alertsStore") as typeof import("./alertsStore");
  expect(useAlerts.getState().alerts.some((x) => x.kind === "release" && x.text === "EIA crude inventories")).toBe(true);
  fireEvent.click(screen.getByText("Holidays"));
  expect(screen.queryByText("EIA crude inventories")).toBeNull();
  expect(screen.getByText("MCX closed: Diwali")).toBeTruthy();
});

test("CalendarWidget Recorded view shows stored figures, the surprise and the log of what was seen", async () => {
  const obs = (kind: string, text: string, num: number, source: string, observedAt: string) => ({ kind, text, num, source, observedAt, backfilled: false });
  mockFetch([
    {
      id: "7",
      series_code: "WNGSR",
      scheduled_at: new Date(Date.now() - 3600_000).toISOString(),
      title: "EIA natural gas storage",
      period: "2026-10-16",
      status: "released",
      observations: [obs("forecast", "80B", 80, "Forex Factory", "2026-10-15T10:00:00Z"), obs("forecast", "82B", 82, "Forex Factory", "2026-10-16T10:00:00Z"), obs("actual", "77B", 77, "EIA", "2026-10-22T15:00:00Z")],
    },
  ]);
  const { CalendarWidget } = require("./CalendarPanel") as typeof import("./CalendarPanel");
  render(<CalendarWidget widget={widget("calendar")} />);
  fireEvent.click(screen.getByText("Recorded"));
  const row = (await screen.findByText("EIA natural gas storage")).closest(".cal-row")!;
  expect(row.querySelector(".cal-fc")!.textContent).toBe("82B"); // the newest forecast is the one believed now
  expect(row.querySelector(".cal-actual")!.textContent).toBe("77B");
  expect(row.textContent).toContain("-5 vs forecast");
  fireEvent.click(row.querySelector("button")!);
  expect(document.body.textContent).toContain("80B"); // the earlier forecast stays on record
});

test("HelpDialog welcomes first-time users once, lists codes and the glossary", () => {
  const { HelpDialog } = require("./HelpDialog") as typeof import("./HelpDialog");
  const { useSettings } = require("./settings") as typeof import("./settings");
  useSettings.setState({ helpSeen: false });
  const onClose = mock(() => {});
  const { rerender } = render(<HelpDialog open={true} onClose={onClose} />);
  expect(document.body.textContent).toContain("Welcome to Divya Drishti");
  expect(document.body.textContent).toContain("Energy Calendar"); // from the panel codes
  expect(document.body.textContent).toContain("Open interest");
  fireEvent.click(screen.getByText("Got it"));
  expect(onClose).toHaveBeenCalled();
  rerender(<HelpDialog open={false} onClose={onClose} />);
  expect(useSettings.getState().helpSeen).toBe(true);
});

test("CotWidget shows managed-money positioning, its change and rank, and switches market", async () => {
  const g = (long: number, short: number, cl = 0, cs = 0) => ({ long, short, net: long - short, changeLong: cl, changeShort: cs });
  const row = (i: number, net: number) => ({
    date: Date.UTC(2026, 0, 6 + i * 7), openInterest: 1_000_000,
    managedMoney: { ...g(200_000 + net, 200_000, 8_000, -2_000), spread: 5 }, producers: g(300, 200), swapDealers: g(100, 50), otherReportable: g(10, 20), nonReportable: g(5, 5),
  });
  const history = Array.from({ length: 40 }, (_, i) => row(i, i * 1000));
  const urls: string[] = [];
  globalThis.fetch = mock(async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ rows: history }) };
  }) as never;
  const { CotWidget } = require("./CotPanel") as typeof import("./CotPanel");
  render(<CotWidget widget={widget("cot")} />);
  expect(await screen.findByText(/Managed money net/)).toBeTruthy();
  expect(document.body.textContent).toContain("+39,000"); // last row: net 39,000
  expect(document.body.textContent).toContain("+10,000 this week"); // 8,000 long change minus -2,000 short change
  expect(document.body.textContent).toContain("100th percentile"); // the newest row is the highest of the history
  fireEvent.click(screen.getByText("Nat gas"));
  await screen.findByText(/Managed money net/);
  expect(urls.some((u) => u.includes("market=natgas"))).toBe(true);
});

import { GRID_COLS, SIZE } from "./workspace";

test("no panel is wider than the grid: react-grid-layout crashes the tab on a panel wider than its columns", () => {
  for (const [type, { w }] of Object.entries(SIZE)) expect(w, `${type} is ${w} columns wide in a ${GRID_COLS}-column grid`).toBeLessThanOrEqual(GRID_COLS);
});
