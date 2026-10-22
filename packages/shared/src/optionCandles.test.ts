import { expect, test } from "bun:test";
import { lastMcxClose, MAX_WINDOW_DAYS, optionCandlesUrl, optionIntradayUrl, recordingWindow, selectRecordingContracts, shouldRecord } from "./optionCandles";
import type { OptionContract } from "./options";

const ist = (iso: string) => Date.parse(`${iso}+05:30`);
const DAY = 86_400_000;

// ---- contract selection
const E1 = Date.UTC(2026, 10, 17); // 17 Nov
const E2 = Date.UTC(2026, 11, 16); // 16 Dec
const E3 = Date.UTC(2027, 0, 15);
const mk = (underlying: string, expiry: number, strike: number, type: "CE" | "PE", fut: string): OptionContract => ({
  instrument_key: `MCX_FO|${underlying}-${expiry}-${strike}-${type}`,
  trading_symbol: `${underlying} ${strike} ${type}`,
  instrument_type: type,
  underlying_symbol: underlying,
  underlying_key: fut,
  strike_price: strike,
  expiry,
});
const strikesOf = (lo: number, hi: number, step: number) => Array.from({ length: (hi - lo) / step + 1 }, (_, i) => lo + i * step);
const book = [
  ...[E1, E2, E3].flatMap((e) => strikesOf(8000, 11000, 50).flatMap((k) => [mk("CRUDEOIL", e, k, "CE", `FUT-C-${e}`), mk("CRUDEOIL", e, k, "PE", `FUT-C-${e}`)])),
  ...[E1, E2].flatMap((e) => strikesOf(200, 400, 5).flatMap((k) => [mk("NATGASMINI", e, k, "CE", `FUT-G-${e}`), mk("NATGASMINI", e, k, "PE", `FUT-G-${e}`)])),
  ...strikesOf(8000, 9000, 50).map((k) => mk("CRUDEOILM", E1, k, "CE", "FUT-M")), // not one of the recorded underlyings
];
const now = ist("2026-10-22T20:00:00");

test("selectRecordingContracts: the first two expiries of crude and gas mini, eleven strikes around each expiry's own future, calls and puts", () => {
  const out = selectRecordingContracts(book, { [`FUT-C-${E1}`]: 9347, [`FUT-C-${E2}`]: 9300, [`FUT-G-${E1}`]: 262, [`FUT-G-${E2}`]: 280 }, now);
  expect(out).toHaveLength(2 * 22 + 2 * 22); // crude 2 expiries + gas 2 expiries, 11 strikes x 2 sides
  const crude1 = out.filter((c) => c.underlying_symbol === "CRUDEOIL" && c.expiry === E1);
  expect(crude1.every((c) => c.strike_price >= 9100 && c.strike_price <= 9600)).toBe(true); // ATM 9350, five strikes of 50 each side
  expect(Math.min(...crude1.map((c) => c.strike_price))).toBe(9100);
  expect(Math.max(...crude1.map((c) => c.strike_price))).toBe(9600);
  expect(crude1.filter((c) => c.instrument_type === "CE")).toHaveLength(11);
  const crude2 = out.filter((c) => c.underlying_symbol === "CRUDEOIL" && c.expiry === E2);
  expect(Math.min(...crude2.map((c) => c.strike_price))).toBe(9050); // its own spot, 9300
  expect(out.some((c) => c.expiry === E3)).toBe(false); // only two expiries
  expect(out.some((c) => c.underlying_symbol === "CRUDEOILM")).toBe(false);
  expect(new Set(out.map((c) => c.instrument_key)).size).toBe(out.length);
});

test("an unknown spot falls back to the middle strike instead of recording nothing, and an expired expiry is skipped", () => {
  const out = selectRecordingContracts(book, {}, now);
  expect(out.filter((c) => c.underlying_symbol === "CRUDEOIL" && c.expiry === E1)).toHaveLength(22);
  const past = selectRecordingContracts(book, {}, ist("2026-11-18T10:00:00")); // E1 has expired: the first two are now E2 and E3
  expect(past.some((c) => c.expiry === E1)).toBe(false);
  expect(past.some((c) => c.expiry === E2) && past.some((c) => c.expiry === E3)).toBe(true);
  expect(selectRecordingContracts([], {}, now)).toEqual([]);
});

// ---- when to record
test("lastMcxClose: the latest weekday close, 23:30 in US summer time and 23:55 after the clock change", () => {
  expect(lastMcxClose(ist("2026-10-22T20:00:00"))).toBe(ist("2026-10-21T23:30:00")); // Thursday evening: last close was Wednesday's
  expect(lastMcxClose(ist("2026-10-22T23:45:00"))).toBe(ist("2026-10-22T23:30:00"));
  expect(lastMcxClose(ist("2026-10-24T12:00:00"))).toBe(ist("2026-10-23T23:30:00")); // Saturday: Friday's
  expect(lastMcxClose(ist("2026-10-26T08:00:00"))).toBe(ist("2026-10-23T23:30:00")); // Monday morning: still Friday's
  expect(lastMcxClose(ist("2026-11-10T23:56:00"))).toBe(ist("2026-11-10T23:55:00")); // winter
  expect(lastMcxClose(ist("2026-11-10T23:40:00"))).toBe(ist("2026-11-09T23:55:00"));
});

test("shouldRecord: once after each session has closed and settled, never mid-session repeatedly, and at once when nothing was ever recorded", () => {
  const close = ist("2026-10-22T23:30:00");
  expect(shouldRecord(ist("2026-10-22T10:00:00"), ist("2026-10-22T23:35:00"))).toBe(false); // closed 5 minutes ago: wait for it to settle
  expect(shouldRecord(ist("2026-10-22T10:00:00"), close + 10 * 60_000)).toBe(true);
  expect(shouldRecord(close + 11 * 60_000, close + 20 * 60_000)).toBe(false); // already recorded after this close
  expect(shouldRecord(close + 11 * 60_000, ist("2026-10-23T12:00:00"))).toBe(false); // next day, before the next close
  expect(shouldRecord(close + 11 * 60_000, ist("2026-10-23T23:45:00"))).toBe(true);
  expect(shouldRecord(undefined, ist("2026-10-22T20:00:00"))).toBe(true); // never recorded: catch up now
  expect(shouldRecord(ist("2026-10-23T23:45:00"), ist("2026-10-25T12:00:00"))).toBe(false); // the weekend: no session closed since Friday's recording
});

test("recordingWindow covers from the day of the last recording to today, and never more than one request allows", () => {
  expect(recordingWindow(ist("2026-10-21T23:45:00"), ist("2026-10-22T23:45:00"))).toEqual({ from: "2026-10-20", to: "2026-10-22" });
  expect(recordingWindow(undefined, ist("2026-10-22T20:00:00"))).toEqual({ from: "2026-10-19", to: "2026-10-22" });
  const long = recordingWindow(ist("2026-01-01T00:00:00"), ist("2026-10-22T20:00:00"));
  expect((Date.parse(long.to) - Date.parse(long.from)) / DAY).toBeLessThanOrEqual(MAX_WINDOW_DAYS);
});

test("the candle request names the contract, the window and one-minute candles", () => {
  expect(optionCandlesUrl("MCX_FO|582939", "2026-10-20", "2026-10-22")).toBe("https://api.upstox.com/v3/historical-candle/MCX_FO%7C582939/minutes/1/2026-10-22/2026-10-20");
});

test("today's candles come from the intraday endpoint", () => {
  expect(optionIntradayUrl("MCX_FO|582939")).toBe("https://api.upstox.com/v3/historical-candle/intraday/MCX_FO%7C582939/minutes/1");
});
