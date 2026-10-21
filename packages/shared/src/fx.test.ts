import { expect, test } from "bun:test";
import { fxDelay, parseFxScan } from "./fx";

const scan = (s: string, d: unknown[]) => ({ totalCount: 1, data: [{ s, d }] });

test("reads price, change, range and delay from the scanner row", () => {
  const rows = parseFxScan(scan("FX_IDC:USDINR", [94.45, -0.3377, -0.32, 94.815, 94.4225, "streaming"]), 1000);
  expect(rows).toEqual([{ id: "USDINR", price: 94.45, changePct: -0.3377, change: -0.32, high: 94.815, low: 94.4225, time: 1000, delayedBy: 0 }]);
});

test("a delayed or end-of-day feed is never reported as live", () => {
  expect(fxDelay("streaming")).toBe(0);
  expect(fxDelay("delayed_streaming_900")).toBe(900);
  expect(fxDelay("endofday")).toBe(86_400);
  expect(fxDelay(undefined)).toBe(86_400);
});

test("a missing, zero, text or absurd price drops the row instead of showing a made-up rate", () => {
  for (const bad of [null, 0, "94", NaN, 9.4, 9445]) expect(parseFxScan(scan("FX_IDC:USDINR", [bad, 0, 0, 0, 0, "streaming"]), 1)).toEqual([]);
});

test("unknown tickers and malformed responses are ignored", () => {
  expect(parseFxScan(scan("FX:EURUSD", [1.1, 0, 0, 0, 0, "streaming"]), 1)).toEqual([]);
  for (const bad of [null, {}, { data: "x" }, { data: [null, { s: "FX_IDC:USDINR" }] }]) expect(parseFxScan(bad, 1)).toEqual([]);
});

test("missing optional columns stay undefined, not zero", () => {
  const [r] = parseFxScan(scan("FX_IDC:USDINR", [94.45, null, undefined, null, null, "streaming"]), 1);
  expect(r).toMatchObject({ price: 94.45, delayedBy: 0 });
  expect(r!.change).toBeUndefined();
  expect(r!.changePct).toBeUndefined();
});
