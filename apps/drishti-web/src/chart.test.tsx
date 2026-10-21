import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";

// lightweight-charts draws on a canvas, which happy-dom doesn't have: a recording fake stands in for it
interface Fake {
  setData: ReturnType<typeof mock>;
  update: ReturnType<typeof mock>;
  kind: string;
}
const made: Fake[] = [];
let crosshair: ((p: { time?: number }) => void) | undefined;
const series = (kind: string): Fake & Record<string, unknown> => {
  const s = { kind, setData: mock(() => {}), update: mock(() => {}), priceScale: () => ({ applyOptions() {} }), createPriceLine() {} };
  made.push(s);
  return s;
};
mock.module("lightweight-charts", () => ({
  createChart: () => ({
    addSeries: (def: { kind: string }) => series(def.kind),
    panes: () => [{ setHeight() {} }, { setHeight() {} }],
    subscribeCrosshairMove: (fn: typeof crosshair) => (crosshair = fn),
    remove() {},
  }),
  CandlestickSeries: { kind: "candles" },
  BarSeries: { kind: "bars" },
  LineSeries: { kind: "line" },
  AreaSeries: { kind: "area" },
  HistogramSeries: { kind: "hist" },
  TickMarkType: { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 },
}));

const { Chart } = await import("./Chart");
const { useStore } = await import("./store");
const { toChartTime } = await import("./chartTime");

const T0 = 1_760_000_000 - (1_760_000_000 % 60);
const bars = Array.from({ length: 25 }, (_, i) => ({ time: T0 + i * 60, open: 9000 + i, high: 9010 + i, low: 8990 + i, close: 9005 + i, volume: 100 + i }));
const digits = (text: string) => text.replace(/[,\s]/g, "");

beforeEach(() => {
  made.length = 0;
  crosshair = undefined;
  useStore.setState({ quotes: {} });
  globalThis.fetch = mock(async () => ({ ok: true, json: async () => bars.map((b) => ({ ...b })) })) as never;
});
afterEach(cleanup);

test("legend shows the last bar and the indicator values once history loads", async () => {
  render(<Chart symbol="MCX:CRUDEOIL" tf="1m" indicators={["VOL", "SMA20"]} />);
  const legend = await screen.findByText(/Vol/, { selector: ".chart-legend span" });
  const text = digits(legend.parentElement!.textContent!);
  expect(text).toContain("9029"); // last close
  expect(text).toContain("SMA20");
  // SMA20 of the last 20 closes (9010…9029) = 9019.5, shown to the instrument's whole-rupee precision
  expect(text).toContain("SMA209020");
});

test("a live tick updates the last point only, without reloading history", async () => {
  render(<Chart symbol="MCX:CRUDEOIL" tf="1m" indicators={["VOL"]} />);
  await screen.findByText(/Vol/, { selector: ".chart-legend span" });
  const main = made.find((s) => s.kind === "candles")!;
  expect(main.setData).toHaveBeenCalledTimes(1);
  act(() => {
    useStore.setState({
      quotes: { "MCX:CRUDEOIL": { symbol: "MCX:CRUDEOIL", price: 9100, time: (T0 + 24 * 60 + 10) * 1000, volume: 1, delayedBy: 0, source: "upstox" } as never },
    });
  });
  expect(main.update).toHaveBeenCalled();
  expect(main.setData).toHaveBeenCalledTimes(1);
  expect(digits(document.querySelector(".chart-legend")!.textContent!)).toContain("9100");
});

test("hovering a bar shows that bar's values; leaving returns to the latest", async () => {
  render(<Chart symbol="MCX:CRUDEOIL" tf="1m" indicators={["VOL"]} />);
  await screen.findByText(/Vol/, { selector: ".chart-legend span" });
  const legend = () => digits(document.querySelector(".chart-legend")!.textContent!);
  act(() => crosshair!({ time: toChartTime(bars[3].time) }));
  expect(legend()).toContain("9008"); // bars[3].close
  act(() => crosshair!({}));
  expect(legend()).toContain("9029");
});

test("no history shows the connect-Upstox hint for MCX", async () => {
  globalThis.fetch = mock(async () => ({ ok: true, json: async () => [] })) as never;
  render(<Chart symbol="MCX:CRUDEOIL" tf="1m" />);
  expect(await screen.findByText(/connect Upstox/)).toBeTruthy();
});
