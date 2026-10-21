import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { NewsItem } from "@drishti/shared";
import { PanelBoundary } from "./PanelBoundary";
import { NewsWidget } from "./NewsWidget";
import { HeatmapWidget, ScreenerWidget } from "./EnergyPanels";
import { Palette } from "./Palette";
import { InsiderWidget } from "./InsiderPanel";
import { OptionsWidget } from "./OptionsPanel";
import { useStore } from "./store";
import { useWorkspace, type Widget } from "./workspace";

const widget = (type: Widget["type"]): Widget => ({ id: `w-${type}`, type, symbol: "CRUDEOIL", group: null }) as Widget;

beforeEach(() => {
  useStore.setState({ news: [], quotes: {}, universe: {} });
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

test("Heatmap renders a tile per energy ticker; Screener sorts by column", () => {
  render(<HeatmapWidget widget={widget("heatmap")} />);
  expect(document.querySelectorAll(".heat-tile").length).toBeGreaterThan(20);
  cleanup();

  useStore.setState({ universe: { "NYMEX:CL1!": { price: 90, changePct: 1 }, "NYMEX:NG1!": { price: 3, changePct: -2 } } as never });
  render(<ScreenerWidget widget={widget("screener")} />);
  const rows = () => [...document.querySelectorAll(".screener tbody tr")].map((r) => r.querySelector("td")!.textContent);
  const first = rows()[0];
  fireEvent.click(screen.getByText(/Chg %/)); // default is already Chg % descending → toggles to ascending
  expect(rows()[0]).not.toBe(first);
});

test("Palette runs a command and closes", () => {
  useWorkspace.getState().setPaletteOpen(true);
  const before = useWorkspace.getState().widgets.length;
  render(<Palette />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "HM" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(useWorkspace.getState().widgets.length).toBe(before + 1);
  expect(useWorkspace.getState().paletteOpen).toBe(false);
});

const mockFetch = (body: unknown, ok = true) => {
  globalThis.fetch = mock(async () => ({ ok, status: ok ? 200 : 503, json: async () => body })) as never;
};

test("InsiderWidget shows trades, or the server's hint when SEC contact is missing", async () => {
  mockFetch({ message: "Set SEC_EDGAR_CONTACT in .env" }, false);
  render(<InsiderWidget widget={widget("insider")} />);
  expect(await screen.findByText(/SEC_EDGAR_CONTACT/)).toBeTruthy();
  cleanup();

  mockFetch({ tickers: ["XOM"], trades: [{ ticker: "XOM", owner: "DOE JANE", date: "2026-10-02", code: "S", shares: -1000, price: 110.5, value: 110500, url: "https://sec.test/x" }] });
  render(<InsiderWidget widget={widget("insider")} />);
  const row = (await screen.findByText(/DOE JANE/)).closest("tr")!;
  expect(within(row).getByText("Sell").closest("td")!.className).toBe("down");
});

test("OptionsWidget renders the chain rows and summary", async () => {
  mockFetch({
    underlying: "CRUDEOIL", expiry: "2026-11-17", expiries: ["2026-11-17"], spot: 9100, atm: 9100, pcr: 1.2, maxPain: 9100, updatedAt: 1,
    rows: [{ strike: 9100, ce: { key: "c", ltp: 600, oi: 10 }, pe: { key: "p", ltp: 590, oi: 12 } }],
  });
  render(<OptionsWidget widget={widget("options")} />);
  expect(await screen.findByText("1.20")).toBeTruthy();
  expect(document.querySelector("tr.atm")).toBeTruthy();
});

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

test("OptionsWidget lets you pick the feed and says which one built the chain", async () => {
  const chain = (source: string) => ({
    underlying: "CRUDEOIL", expiry: "2026-11-17", expiries: ["2026-11-17"], spot: 9459, atm: 9450, updatedAt: 1, source,
    rows: [{ strike: 9450, ce: { key: "c", ltp: 524, bid: 523.2, ask: 524.9, iv: 50.4, delta: 0.53, theo: 524.6 }, pe: { key: "p", ltp: 480 } }],
  });
  const urls: string[] = [];
  globalThis.fetch = mock(async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => chain(String(url).includes("source=tradingview") ? "tradingview" : "upstox") };
  }) as never;
  render(<OptionsWidget widget={widget("options")} />);
  expect(await screen.findByText("UPSTOX")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Options feed"), { target: { value: "tradingview" } });
  expect(await screen.findByText("TV")).toBeTruthy();
  expect(urls.some((u) => u.includes("source=tradingview"))).toBe(true);
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
