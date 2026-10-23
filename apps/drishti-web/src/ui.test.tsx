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
  fireEvent.click(screen.getByText("Energy")); // the panel opens on Today
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

test("CalendarWidget tabs split energy from macro, and High + Med hides low-impact rows", async () => {
  const at = Date.now() + 3600_000;
  mockFetch([
    { id: "e1", title: "Baker Hughes rig count", at, kind: "energy", impact: "low" },
    { id: "e2", title: "EIA crude inventories", at, kind: "energy", impact: "high" },
    { id: "m1", title: "CPI y/y (US)", at, kind: "macro", impact: "high" },
  ]);
  const { CalendarWidget } = require("./CalendarPanel") as typeof import("./CalendarPanel");
  render(<CalendarWidget widget={widget("calendar")} />);
  fireEvent.click(screen.getByText("Energy"));
  expect(await screen.findByText("EIA crude inventories")).toBeTruthy();
  expect(screen.queryByText("CPI y/y (US)")).toBeNull();
  fireEvent.click(screen.getByText("High + Med"));
  expect(screen.queryByText("Baker Hughes rig count")).toBeNull();
  fireEvent.click(screen.getByText("Macro"));
  expect(screen.getByText("CPI y/y (US)")).toBeTruthy();
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

test("CalendarWidget Recorded view flags sources that disagree, believes a typed-in forecast, and posts a new one", async () => {
  const obs = (kind: string, text: string, num: number, source: string) => ({ kind, text, num, source, observedAt: "2026-10-22T15:00:00Z", backfilled: false });
  const rows = [
    {
      id: "9",
      series_code: "WNGSR",
      scheduled_at: new Date(Date.now() - 3600_000).toISOString(),
      title: "EIA natural gas storage",
      period: "2026-10-16",
      status: "released",
      observations: [obs("forecast", "80B", 80, "typed in"), obs("forecast", "82B", 82, "Forex Factory"), obs("actual", "77B", 77, "EIA"), obs("actual", "75", 75, "Yahoo Finance"), obs("release_time", "2026-10-22T14:30:00.000Z", Date.UTC(2026, 9, 22, 14, 30), "Finance Calendar")],
    },
  ];
  const calls: [string, RequestInit | undefined][] = [];
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    return { ok: true, status: 200, json: async () => (init?.method === "POST" ? { ok: true } : rows) };
  }) as never;
  const { CalendarWidget } = require("./CalendarPanel") as typeof import("./CalendarPanel");
  render(<CalendarWidget widget={widget("calendar")} />);
  fireEvent.click(screen.getByText("Recorded"));
  const row = (await screen.findByText("EIA natural gas storage")).closest(".cal-row")!;
  expect(row.querySelector(".cal-fc")!.textContent).toBe("80B"); // typed in beats the newer feed figure
  expect(row.textContent).toContain("sources differ");
  fireEvent.click(row.querySelector("button")!);
  expect(document.body.textContent).toContain("actuals differ: 77 (EIA) vs 75 (Yahoo Finance)");
  expect(document.body.textContent).toContain("release time");
  fireEvent.change(screen.getByLabelText("Typed-in forecast"), { target: { value: "-1.2M" } });
  fireEvent.change(screen.getByLabelText("Where you read it"), { target: { value: "Trading Economics" } });
  fireEvent.click(screen.getByText("Add forecast"));
  await screen.findByText("EIA natural gas storage");
  const post = calls.find(([, init]) => init?.method === "POST")!;
  expect(post[0]).toMatch(/\/calendar\/stored\/9\/observations$/);
  expect(JSON.parse(post[1]!.body as string)).toEqual({ kind: "forecast", text: "-1.2M", from: "Trading Economics" });
});

test("CalendarWidget Energy tab marks a release EIA moved and lists the official delays ahead", async () => {
  const at = Date.now() + 3600_000;
  const normalAt = at - 86_400_000;
  globalThis.fetch = mock(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes("/calendar/eia-schedule") ? [{ report: "WPSR", weekKey: "2026-11-06", normalAt, at: at + 20 * 86_400_000, holiday: "Veterans Day" }] : [{ id: "eia-oil-1", title: "EIA crude inventories", at, kind: "energy", impact: "high", delay: { holiday: "Columbus Day", normalAt } }, { id: "eia-gas-2", title: "EIA natural gas storage", at: at + 3600_000, kind: "energy", impact: "high" }]),
  })) as never;
  const { CalendarWidget } = require("./CalendarPanel") as typeof import("./CalendarPanel");
  render(<CalendarWidget widget={widget("calendar")} />);
  fireEvent.click(screen.getByText("Energy"));
  const moved = (await screen.findByText("EIA crude inventories")).closest(".cal-row")!;
  expect(moved.textContent).toContain("DELAYED");
  expect(moved.querySelector(".cal-delayed")!.getAttribute("title")).toMatch(/EIA moved this release for Columbus Day/);
  expect(screen.getByText("EIA natural gas storage").closest(".cal-row")!.textContent).not.toContain("DELAYED");
  expect(await screen.findByText(/EIA delays ahead:/)).toBeTruthy();
  expect(document.querySelector(".cal-delays")!.textContent).toContain("crude (Veterans Day)");
  fireEvent.click(screen.getByText("Macro")); // the strip belongs to the Energy tab only
  expect(document.querySelector(".cal-delays")).toBeNull();
});

test("CalendarWidget opens on Today: the next 24 hours of what moves crude, with a switch to gas and to everything", async () => {
  const now = Date.now();
  const H = 3_600_000;
  mockFetch([
    { id: "eia-oil-1", title: "EIA crude inventories", at: now + 2 * H, kind: "energy", impact: "high", relevance: ["crude"] },
    { id: "eia-gas-2", title: "EIA natural gas storage", at: now + 3 * H, kind: "energy", impact: "high", relevance: ["gas"] },
    { id: "ff-USD-3-CPI", title: "CPI y/y (US)", at: now + 4 * H, kind: "macro", impact: "high", relevance: ["crude", "usdinr"] },
    { id: "ff-JPY-4-BOJ", title: "BoJ rate", at: now + 5 * H, kind: "macro", impact: "high", relevance: ["usdinr"] },
    { id: "eia-oil-5", title: "EIA crude inventories next week", at: now + 40 * H, kind: "energy", impact: "high", relevance: ["crude"] },
  ]);
  try {
    localStorage.removeItem("drishti-calendar-focus");
  } catch {
    /* no storage: the default is crude */
  }
  const { CalendarWidget } = require("./CalendarPanel") as typeof import("./CalendarPanel");
  render(<CalendarWidget widget={widget("calendar")} />);
  expect(await screen.findByText("EIA crude inventories")).toBeTruthy(); // no tab clicked: Today
  expect(screen.getByText("CPI y/y (US)")).toBeTruthy(); // a US release moves crude and the rupee
  expect(screen.queryByText("EIA natural gas storage")).toBeNull();
  expect(screen.queryByText("EIA crude inventories next week")).toBeNull(); // beyond 24 hours
  fireEvent.click(screen.getByText("Gas"));
  expect(screen.getByText("EIA natural gas storage")).toBeTruthy();
  expect(screen.queryByText("EIA crude inventories")).toBeNull();
  fireEvent.click(screen.getByText("All"));
  expect(screen.getByText("BoJ rate")).toBeTruthy();
});

test("DriversWidget shows the NYMEX and rupee legs with the delay, the fair value, the premium and the split of the day move", async () => {
  const q = (symbol: string, price: number, prevClose: number, delayedBy = 0) => ({ symbol, price, prevClose, time: Date.now(), source: "tradingview", delayedBy });
  useStore.setState({ quotes: { "MCX:CRUDEOIL": q("MCX:CRUDEOIL", 9600, 9500) as never, "NYMEX:CL": q("NYMEX:CL", 101, 100, 600) as never, "FX:USDINR": q("FX:USDINR", 95.2, 95) as never } });
  const times = Array.from({ length: 40 }, (_, i) => 1000 + i * 300);
  globalThis.fetch = mock(async (url: string) => {
    const close = String(url).includes("MCX") ? 9500 : String(url).includes("NYMEX") ? 100 : 95;
    return { ok: true, status: 200, json: async () => times.map((time) => ({ time, open: close, high: close, low: close, close, volume: 0 })) };
  }) as never;
  const { DriversWidget } = require("./DriversPanel") as typeof import("./DriversPanel");
  render(<DriversWidget widget={{ ...widget("drivers"), symbol: "MCX:CRUDEOIL" }} />);
  expect(screen.getByText("MCX MCX:CRUDEOIL".replace("MCX MCX:", "MCX "))).toBeTruthy();
  expect(screen.getByText("10 min late")).toBeTruthy(); // the free NYMEX feed
  expect(screen.getByText("9,615")).toBeTruthy(); // 101 x 95.2
  expect(document.querySelector(".drv-fair")!.textContent).toContain("-15 (-0.16%)"); // MCX 9600 against 9615.2
  expect(document.querySelector(".drv-split")!.textContent).toContain("+1.05%");
  expect(document.querySelector(".drv-split")!.textContent).toMatch(/NYMEX\+1\.00.*Rupee\+0\.21.*Premium-0\.16/);
  expect(await screen.findByText(/now higher than \d+% of the last 40 bars/)).toBeTruthy();
  expect(document.body.textContent).toContain("NYMEX is 10 minutes late");
});

test("DriversWidget explains itself on a symbol it does not cover", () => {
  const { DriversWidget } = require("./DriversPanel") as typeof import("./DriversPanel");
  render(<DriversWidget widget={{ ...widget("drivers"), symbol: "NYMEX:CL" }} />);
  expect(screen.getByText(/four MCX energy futures/)).toBeTruthy();
});

test("LabelWidget shows one headline, labels it from the keyboard, flags a reported move, takes the last label back and skips", async () => {
  const items = [{ id: 1, title: "Oil jumps as tankers are attacked", outlet: "Reuters" }, { id: 2, title: "OPEC secretary general to speak", outlet: "Bloomberg" }];
  let next = 0;
  const calls: [string, RequestInit | undefined][] = [];
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push([String(url), init]);
    if (init?.method === "POST") next++;
    if (init?.method === "DELETE") next = 0;
    return { ok: true, status: 200, json: async () => ({ item: items[next] ?? null, total: 2, done: next }) };
  }) as never;
  const { LabelWidget } = require("./LabelPanel") as typeof import("./LabelPanel");
  render(<LabelWidget widget={widget("labels")} />);
  expect(await screen.findByText("Oil jumps as tankers are attacked")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/lexicon|score|\d{4}-\d{2}-\d{2}/i); // no model score and no date is shown to the labeler
  const box = screen.getByRole("region");
  fireEvent.keyDown(box, { key: "m" });
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  fireEvent.keyDown(box, { key: "1" }); // bullish, with the flag
  expect(await screen.findByText("OPEC secretary general to speak")).toBeTruthy();
  const post = calls.find(([, i]) => i?.method === "POST")!;
  expect(JSON.parse(post[1]!.body as string)).toEqual({ sampleId: 1, labeler: "owner", label: "bullish", afterMove: true });
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false); // the flag does not carry over
  fireEvent.keyDown(box, { key: "u" }); // take it back
  expect(await screen.findByText("Oil jumps as tankers are attacked")).toBeTruthy();
  expect(calls.some(([u, i]) => u.includes("/labels/last") && i?.method === "DELETE")).toBe(true);
  fireEvent.keyDown(box, { key: "s" });
  expect(calls.filter(([u]) => u.includes("/labels/next")).at(-1)![0]).toContain("skip=1");
});

test("EiaReportWidget shows the headline, the surprise side, the analysis lines and the tables, and sends a typed forecast", async () => {
  const row = (seriesId: string, table: string, label: string, value: number, change: number, extra: object = {}) => ({ seriesId, report: "WPSR", table, group: "", parent: "", label, unit: "million barrels", seq: 0, periodEnd: 0, value, prior: value - change, change, headline: false, ...extra });
  const body = {
    weekEnding: "2026-10-16",
    scheduledAt: Date.now(),
    officialReleaseAt: Date.now() - 5000,
    delayMs: 3400,
    backfilled: false,
    forecast: { value: 0.5, source: "typed in" },
    rows: [row("WPSR:T1:COMMERCIAL_EXCLUDING_SPR", "T1", "Commercial (Excluding SPR)", 412.517, -3.061, { headline: true }), row("WPSR:T4:CUSHING", "T4", "Cushing", 27.594, 0.987)],
    analysis: {
      report: "WPSR",
      weekEnding: "2026-10-16",
      headline: { label: "Commercial crude stocks (excluding SPR)", unit: "MB", level: 412.517, change: -3.061, yearAgoPct: -2.4, forecast: 0.5, surprise: -3.561, threshold: 3, passes: true, side: "long", sideText: "Surprise -3.6 MB (below forecast) passes 3.0: the rule allows long (calls) only" },
      sections: [{ id: "crude", title: "Crude stocks", lines: [{ id: "a", severity: "flag", text: "Cushing built 0.987 MB to 27.6 MB.", cites: ["WPSR:T4:CUSHING"] }] }],
    },
  };
  mockFetch(body);
  const { EiaReportWidget } = require("./EiaReportPanel") as typeof import("./EiaReportPanel");
  render(<EiaReportWidget widget={widget("eiareport")} />);
  fireEvent.click(screen.getByText("Petroleum (WPSR)")); // the default report follows the weekday in New York
  expect(await screen.findByText(/allows long \(calls\) only/)).toBeTruthy();
  expect(document.querySelector(".er-sur .er-big")!.textContent).toBe("-3.6");
  expect(document.querySelector(".er-sur .er-big")!.className).toContain("up"); // long side, up colour
  expect(screen.getByText("Cushing built 0.987 MB to 27.6 MB.")).toBeTruthy();
  expect(document.body.textContent).toContain("stored 3.4 s after the release");
  fireEvent.click(screen.getByText("T4")); // the tables: switch to table 4
  expect(screen.getAllByText("Cushing").length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText("Forecast of the change"), { target: { value: "-1.2" } });
  await screen.findByText(/allows long/);
  const urls = ((globalThis.fetch as any).mock.calls as [string][]).map((c) => c[0]);
  expect(urls.some((u) => u.includes("forecast=-1.2") && u.includes("report=WPSR"))).toBe(true);
});

test("HelpDialog welcomes first-time users once, lists codes and the glossary", () => {
  const { HelpDialog } = require("./HelpDialog") as typeof import("./HelpDialog");
  const { useSettings } = require("./settings") as typeof import("./settings");
  useSettings.setState({ helpSeen: false });
  const onClose = mock(() => {});
  const { rerender } = render(<HelpDialog open={true} onClose={onClose} />);
  expect(document.body.textContent).toContain("Welcome to Divya Drishti");
  expect(document.body.textContent).toContain("Calendar"); // from the panel codes
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
