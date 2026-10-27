import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UsibWidget } from "./UsibPanel";
import { useAlerts } from "./alertsStore";
import type { Widget } from "./workspace";

const OPEN = Date.UTC(2026, 9, 27, 13, 30); // Tue 27 Oct 2026, 09:30 New York = 19:00 IST
const OPENS = OPEN / 1000;
const widget = { id: "us", type: "usib", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;
const bar = (time: number, o: number, h: number, l: number, c: number, volume = 10) => ({ time, open: o, high: h, low: l, close: c, volume });
/** two hours before the open at volume 10, the hour before it between 100 and 110 */
const before = Array.from({ length: 24 }, (_, i) => bar(OPENS - 7200 + i * 300, 105, i === 15 ? 110 : 107, i === 20 ? 100 : 103, 105));
const after = (rows: [number, number, number, number, number][]) => rows.map(([o, h, l, c, v], i) => bar(OPENS + i * 300, o, h, l, c, v));
const signalBars = [...before, ...after([[105, 106, 104, 105, 10], [105, 112, 104, 111, 20], [111.5, 112, 110, 111.8, 12]])];

const leg = (delta: number, ask: number, oi: number) => ({ key: "k", ukey: `MCX_FO|${ask}`, ask, bid: ask - 5, ltp: ask, delta, theta: -5, iv: 40, oi, volume: 50 });
const chain = { underlying: "CRUDEOIL", expiry: "2026-11-17", expiries: ["2026-11-17"], atm: 9600, lot: 100, updatedAt: 0, rows: [[9500, 0.62, 240, 100], [9550, 0.57, 200, 200], [9600, 0.52, 170, 9000], [9650, 0.46, 140, 300], [9700, 0.4, 110, 400]].map(([strike, d, ask, oi]) => ({ strike, ce: leg(d, ask, oi), pe: leg(-d, ask, oi) })) };

function serve(bars: object[], events: object[] = []) {
  globalThis.fetch = mock(async (u: string) => {
    const url = String(u);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes("/calendar/stored")) return ok(url.includes("series=WPSR") ? events : []);
    if (url.includes("/bars")) return ok(bars);
    if (url.includes("/options")) return ok({ ...chain, updatedAt: Date.now() });
    return { ok: false, status: 404, json: async () => ({}) };
  }) as never;
}

beforeEach(() => {
  localStorage.clear();
  useAlerts.setState({ history: [], toasts: [] });
  setSystemTime(new Date(OPEN + 12 * 60_000));
  serve(signalBars);
});
afterEach(() => {
  cleanup();
  setSystemTime();
});

test("the entry window: each candle with its volume and VWAP side, and the signal with its levels, TP2 from the chain and the trail", async () => {
  render(<UsibWidget widget={widget} />);
  expect(await screen.findByText("Entry window")).toBeTruthy();
  expect(screen.getByText(/New signals until/)).toBeTruthy();
  const rows = Array.from(document.querySelectorAll(".rd-table")[0].querySelectorAll("tbody tr"));
  await waitFor(() => expect(document.querySelectorAll(".rd-table")[0].querySelectorAll("tbody tr").length).toBe(3)); // the third candle is still forming
  expect(rows[1].textContent).toContain("above");
  expect(rows[1].textContent).toContain("2.0x");
  expect(await screen.findByText(/SIGNAL: LONG/)).toBeTruthy();
  expect(screen.getByText("111.5")).toBeTruthy(); // the entry reference
  expect(screen.getAllByText(/then the stop trails/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/call OI wall|2R|round strike/).length).toBeGreaterThan(0); // where TP2 came from
  await waitFor(() => expect(screen.getByText("9600 CE")).toBeTruthy());
  await waitFor(() => expect(useAlerts.getState().history.some((h) => /USIB: SIGNAL LONG/.test(h.message))).toBe(true));
});

test("a break with too little volume is shown as filtered and does not make a signal", async () => {
  serve([...before, ...after([[105, 112, 104, 111, 12], [111, 112, 110, 111.5, 10]])]);
  render(<UsibWidget widget={widget} />);
  expect(await screen.findByText(/was filtered: volume 1.2x under 1.5x/)).toBeTruthy();
  expect(screen.queryByText(/SIGNAL/)).toBeNull();
  expect(screen.getByText(/No signal yet/)).toBeTruthy();
});

test("a report day is said so: the USIB is not the day's trade", async () => {
  serve(signalBars, [{ id: "1", series_code: "WPSR", scheduled_at: new Date(Date.UTC(2026, 9, 27, 14, 30)).toISOString(), status: "scheduled", observations: [] }]);
  render(<UsibWidget widget={widget} />);
  expect(await screen.findByText(/report-day strategy is the day's trade/)).toBeTruthy();
});

test("before the range hour: waiting, with the readiness list for the open", async () => {
  setSystemTime(new Date(OPEN - 3 * 3600_000));
  cleanup();
  serve(before);
  render(<UsibWidget widget={widget} />);
  expect(await screen.findByText("Waiting")).toBeTruthy();
  expect(screen.getByText(/Range hour starts in 2h/)).toBeTruthy();
  const list = document.querySelector(".rd-ready")!;
  expect(list.querySelectorAll("li")).toHaveLength(4);
  await waitFor(() => expect(list.querySelectorAll("li.up").length).toBeGreaterThanOrEqual(2)); // a USIB day and volume in the candles
});

test("entering the trade keeps USIB's own record: the chain level for TP2, the trail and the 150 to 180 minute time stop", async () => {
  render(<UsibWidget widget={widget} />);
  fireEvent.click(await screen.findByText("I entered this trade"));
  await waitFor(() => expect((screen.getByLabelText("Premium paid") as HTMLInputElement).value).toBe("170"));
  fireEvent.click(screen.getByText("Follow this trade"));
  expect(await screen.findByText(/In trade: LONG 9600 CE/)).toBeTruthy();
  const rec = JSON.parse(localStorage.getItem("drishti-reportday")!)[`usib:${OPEN}`];
  expect(rec.trade).toMatchObject({ side: "long", releaseAt: OPEN, timeStop: { fromMin: 150, toMin: 180 } });
  expect(rec.trade.trail).toBeGreaterThan(0);
  expect(rec.trade.tp2).toBeGreaterThan(rec.trade.tp1);
  expect(screen.getByLabelText("Trade in progress").textContent).toMatch(/Time stop: .* to /);
});
