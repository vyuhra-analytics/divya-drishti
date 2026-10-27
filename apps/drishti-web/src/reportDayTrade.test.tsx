import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReportDayWidget } from "./ReportDayPanel";
import { useAlerts } from "./alertsStore";
import { useStore } from "./store";
import type { Widget } from "./workspace";

const REL = Date.UTC(2026, 9, 28, 14, 30);
const RELS = REL / 1000;
const widget = { id: "rd", type: "reportday", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;
const bar = (time: number, o: number, h: number, l: number, c: number) => ({ time, open: o, high: h, low: l, close: c, volume: 10 });
const hour = Array.from({ length: 12 }, (_, i) => bar(RELS - 3600 + i * 300, 105, i === 3 ? 110 : 107, i === 8 ? 100 : 103, 105));
/** inside, closed above (the signal), then the next candle opening at 111.5 */
const window = [bar(RELS, 105, 106, 104, 105), bar(RELS + 300, 105, 112, 104, 111), bar(RELS + 600, 111.5, 112, 110, 111.8)];
const leg = (delta: number, ask: number) => ({ key: "k", ukey: `MCX_FO|${Math.round(ask)}`, ask, bid: ask - 5, ltp: ask, delta, theta: -5, iv: 40, oi: 1000, volume: 50 });
const chain = { underlying: "CRUDEOIL", expiry: "2026-11-17", expiries: [], atm: 9600, lot: 100, updatedAt: REL, rows: [[9500, 0.62, 240], [9550, 0.57, 200], [9600, 0.52, 170], [9650, 0.46, 140], [9700, 0.4, 110]].map(([strike, d, ask]) => ({ strike, ce: leg(d, ask), pe: leg(-d, ask) })) };

function serve(bars: object[]) {
  globalThis.fetch = mock(async (u: string) => {
    const url = String(u);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes("/calendar/stored")) return ok(url.includes("series=WPSR") ? [{ id: "1", series_code: "WPSR", scheduled_at: new Date(REL).toISOString(), status: "scheduled", observations: [] }] : []);
    if (url.includes("/eia-report/forecasts")) return ok({ releases: [{ releaseAt: REL, upcoming: true, crude: { forecast: -0.3 }, storage: {} }] });
    if (url.includes("/eia-report?")) return ok({ officialReleaseAt: REL + 20_000, scheduledAt: REL, analysis: { headline: { change: -8.557, unit: "MB" } } });
    if (url.includes("/bars")) return ok(bars);
    if (url.includes("/options")) return ok({ ...chain, updatedAt: Date.now() });
    return { ok: false, status: 404, json: async () => ({}) };
  }) as never;
}
const setPrice = (price: number) => act(() => void useStore.setState({ quotes: { "MCX:CRUDEOIL": { symbol: "MCX:CRUDEOIL", price, time: Date.now() } } as never }));

beforeEach(() => {
  localStorage.clear();
  useAlerts.setState({ history: [], toasts: [] });
  setSystemTime(new Date(REL + 12 * 60_000));
  serve([...hour, ...window]);
  setPrice(111.8);
});
afterEach(() => {
  cleanup();
  setSystemTime();
});

async function enterTrade() {
  render(<ReportDayWidget widget={widget} />);
  fireEvent.click(await screen.findByText("I entered this trade"));
  const future = (await screen.findByLabelText("Future entry price")) as HTMLInputElement;
  await waitFor(() => expect((screen.getByLabelText("Premium paid") as HTMLInputElement).value).toBe("170")); // the suggested strike's ask
  expect(future.value).toBe("111.5"); // the next open after the signal
  expect((screen.getByLabelText("Option strike") as HTMLInputElement).value).toBe("9600");
  fireEvent.click(screen.getByText("Follow this trade"));
  return await screen.findByText(/In trade: LONG 9600 CE/);
}

test("the number being out is announced once, with the surprise and the side it allows", async () => {
  render(<ReportDayWidget widget={widget} />);
  await waitFor(() => expect(useAlerts.getState().history.some((h) => /the number is out, -8.557 MB, surprise -8.26: allows a LONG/.test(h.message))).toBe(true));
  expect(useAlerts.getState().history.filter((h) => h.message.includes("the number is out"))).toHaveLength(1);
  await waitFor(() => expect(useAlerts.getState().history.some((h) => /SIGNAL LONG/.test(h.message))).toBe(true));
});

test("no entry button without a signal", async () => {
  cleanup();
  serve([...hour, bar(RELS, 105, 106, 104, 105), bar(RELS + 300, 105, 106, 104, 105)]);
  render(<ReportDayWidget widget={widget} />);
  await screen.findByText("Window");
  expect(screen.queryByText("I entered this trade")).toBeNull();
});

test("entering the trade: the form is prefilled from the signal and the suggested strike, and the screen then follows it in R and rupees", async () => {
  await enterTrade();
  await setPrice(113.0); // 1.5 points above the 111.5 entry
  const live = screen.getByLabelText("Trade in progress");
  await waitFor(() => expect(live.textContent).toContain("+0.22R")); // 1.5 points against R = 6.9 points (1.5 x the ATR of these candles)
  expect(live.textContent).toContain("R = 6.9 points");
  expect(live.textContent).toContain("bought 170.0 · bid 165.0"); // the chain's bid until the live option quote arrives
  expect(live.textContent).toContain("−₹500"); // (165 - 170) x 100 units
  expect(live.textContent).toContain("Loss cap ₹2,000");
  expect(live.textContent).toMatch(/Time stop: .* to /);
  expect(live.textContent).toContain("This only follows the trade");
  expect(await screen.findByText("In trade", { selector: "b" }, { timeout: 3000 })).toBeTruthy(); // the strip follows the trader's own stage
  expect(screen.queryByText("I entered this trade")).toBeNull();
});

test("a milestone is announced once and flashed; the stop level raises the alarm", async () => {
  await enterTrade();
  await setPrice(100); // far below the stop
  await waitFor(() => expect(useAlerts.getState().history.some((h) => /STOP level reached/.test(h.message))).toBe(true));
  expect(useAlerts.getState().history.filter((h) => /STOP level reached/.test(h.message))).toHaveLength(1);
  expect(document.querySelector(".rd-flash")?.textContent).toContain("STOP level reached");
  await setPrice(99);
  expect(useAlerts.getState().history.filter((h) => /STOP level reached/.test(h.message))).toHaveLength(1); // not again
  // the milestone is kept with the trade
  expect(JSON.parse(localStorage.getItem("drishti-reportday")!)[String(REL)].trade.events.map((e: { kind: string }) => e.kind)).toContain("stop");
});

test("exiting closes the record into a review with the rupee result and a note, locks new entries, and survives a reload", async () => {
  await enterTrade();
  fireEvent.click(screen.getByText("I exited the trade"));
  const premium = (await screen.findByLabelText("Premium you sold at")) as HTMLInputElement;
  fireEvent.change(premium, { target: { value: "185" } });
  fireEvent.change(screen.getByLabelText("Why"), { target: { value: "tp1" } });
  fireEvent.click(screen.getByText("Close the record"));
  expect(await screen.findByText("Done: review")).toBeTruthy();
  expect(await screen.findByText("Done", {}, { timeout: 3000 })).toBeTruthy(); // the strip, at its next one-second tick
  const review = screen.getByLabelText("Trade review");
  expect(review.textContent).toContain("₹1,500"); // (185 - 170) x 100
  expect(review.textContent).toContain("Took profit at TP1");
  expect(review.textContent).toContain("New entries are locked until the next release");
  expect(screen.queryByText("I entered this trade")).toBeNull();
  fireEvent.change(screen.getByLabelText("Trade note"), { target: { value: "waited for the close" } });
  fireEvent.blur(screen.getByLabelText("Trade note"));
  cleanup();
  render(<ReportDayWidget widget={widget} />);
  expect(await screen.findByText("Done: review")).toBeTruthy();
  expect((screen.getByLabelText("Trade note") as HTMLTextAreaElement).value).toBe("waited for the close");
});

test("the readiness checklist in prep names each thing that must work before the print", async () => {
  setSystemTime(new Date(REL - 3 * 3600_000));
  cleanup();
  serve(hour);
  render(<ReportDayWidget widget={widget} />);
  expect(await screen.findByText("Ready for the print?")).toBeTruthy();
  const list = document.querySelector(".rd-ready")!;
  await waitFor(() => expect(list.textContent).toContain("Forecast"));
  expect(list.querySelectorAll("li")).toHaveLength(5);
  await waitFor(() => expect(list.querySelectorAll("li.up").length).toBeGreaterThanOrEqual(3)); // release, forecast and the report source answer
});
