import { expect, test } from "bun:test";
import { registerSessionBreaks, sessionBreakIndicator, SESSION_BREAKS_ID } from "./advSessionBreaks";

const bar = (time: number, p: number) => ({ time, open: p, high: p + 1, low: p - 1, close: p });
const settings = (over: Record<string, unknown> = {}) => ({ ...Object.fromEntries(sessionBreakIndicator().inputs.map((i) => [i.key, i.default])), ...over });
/** two sessions of five-minute candles with nine hours between them */
const bars = [...Array.from({ length: 6 }, (_, i) => bar(1_000_000 + i * 300, 100 + i)), ...Array.from({ length: 6 }, (_, i) => bar(1_000_000 + 6 * 300 + 9 * 3600 + i * 300, 200 + i))];

type Line = { kind: string; from: { time: number; price: number }; to: { time: number; price: number }; lineStyle: string };
const draws = (s: Record<string, unknown>) => sessionBreakIndicator().draws!({ bars, values: {}, settings: s }) as unknown as Line[];

test("draws a solid vertical line at the open of the session after each break, from the lowest to the highest price", () => {
  const lines = draws(settings());
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ kind: "line", lineStyle: "solid" });
  expect(lines[0]).not.toHaveProperty("extendLeft"); // a vertical line with an extension did not draw in the library
  expect(lines[0].from.time).toBe(1_000_000 + 6 * 300 + 9 * 3600);
  expect(lines[0].to.time).toBe(lines[0].from.time); // vertical
  expect(lines[0].from.price).toBe(99); // the lowest low
  expect(lines[0].to.price).toBe(206); // the highest high
});

test("the close line is off until asked for, and the open line can be switched off", () => {
  expect(draws(settings({ show_close: true })).map((l) => l.from.time)).toEqual([1_000_000 + 6 * 300 + 9 * 3600, 1_000_000 + 6 * 300]);
  expect(draws(settings({ show_open: false }))).toEqual([]);
});

test("a shortest-break setting above the gap draws nothing, and a chart without a break draws nothing", () => {
  expect(draws(settings({ min_gap: 600 }))).toHaveLength(0); // 540-minute gap under 600
  expect(sessionBreakIndicator().draws!({ bars: bars.slice(0, 6), values: {}, settings: settings() })).toEqual([]);
});

test("registers once, and a registration that throws leaves the chart alone", () => {
  const seen: string[] = [];
  registerSessionBreaks((d) => seen.push(d.id), (id) => seen.includes(id));
  registerSessionBreaks((d) => seen.push(d.id), (id) => seen.includes(id));
  expect(seen).toEqual([SESSION_BREAKS_ID]);
  expect(() => registerSessionBreaks(() => { throw new Error("nope"); }, () => false)).not.toThrow();
});

test("shades the first candle of the session after each break, and the last one before it when the close is on", () => {
  const d = sessionBreakIndicator();
  const open = 6; // index of the first candle after the break
  const bg = d.background!({ bars, values: {}, settings: settings() }) as (string | null)[];
  expect(bg).toHaveLength(bars.length);
  expect(bg.filter((c) => c !== null)).toHaveLength(1);
  expect(bg[open]).toMatch(/^rgba\(255, 213, 79, 0\.35\)$/);
  const both = d.background!({ bars, values: {}, settings: settings({ show_close: true }) }) as (string | null)[];
  expect(both[open - 1]).toMatch(/^rgba\(144, 164, 174, 0\.3\)$/);
  expect(d.background!({ bars, values: {}, settings: settings({ show_open: false }) }).every((c) => c === null)).toBe(true);
});

test("labels the open with an arrow on the first candle (and the close on the last one before the break), unless labels are off", () => {
  const d = sessionBreakIndicator();
  const marks = d.markers!({ bars, values: {}, settings: settings({ show_close: true }) }) as unknown as { time: number; text: string; position: string }[];
  expect(marks.map((m) => [m.text, m.time])).toEqual([["Open", bars[6].time], ["Close", bars[5].time]]);
  expect(marks[0].position).toBe("belowBar");
  expect(d.markers!({ bars, values: {}, settings: settings({ show_labels: false }) })).toEqual([]);
});
