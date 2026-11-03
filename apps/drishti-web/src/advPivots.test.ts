import { expect, test } from "bun:test";
import { PIVOTS_ID, pivotsIndicator, pivotTags, registerPivots } from "./advPivots";

const bar = (t: number, high: number, low: number, close: number) => ({ time: t, open: close, high, low, close, volume: 1 }) as never;
const day = (d: number, high: number, low: number, close: number) => [bar(d * 86_400, high, low, close), bar(d * 86_400 + 300, high, low, close), bar(d * 86_400 + 600, high, low, close)];
const bars = [...day(1, 105, 95, 100), ...day(2, 110, 90, 104), ...day(3, 120, 100, 115)];
type Draw = { kind: string; from: { time: number; price: number }; to?: { time: number }; text?: string };
const tags = (settings: Record<string, unknown>) => pivotTags(bars as never, settings).map((t) => t.text);
const draw = (settings: Record<string, unknown>) => pivotsIndicator().draws!({ bars, settings } as never) as unknown as Draw[];

test("one session after the first two: seven flat lines, previous high and low, and labels on the newest", () => {
  const d = draw({});
  const lines = d.filter((x) => x.kind === "line");
  expect(lines).toHaveLength(9); // P, R1-3, S1-3, previous high, previous low
  expect(lines.every((l) => l.from.time === 3 * 86_400 && l.to!.time === 3 * 86_400 + 600)).toBe(true);
  expect(lines.some((l) => l.from.price === 110)).toBe(true); // previous session high
  expect(d.some((x) => x.kind === "label")).toBe(false); // the names are price-axis tags now
  expect(tags({})).toContain("P 101.33");
  expect(tags({})).toContain("PDH 110");
});

test("labels and previous high/low can be switched off, and the formula changes the levels", () => {
  expect(tags({ show_labels: false })).toHaveLength(0);
  expect(tags({ show_prev: false }).some((t) => t.startsWith("PDH"))).toBe(false);
  expect(draw({ show_prev: false }).filter((x) => x.kind === "line")).toHaveLength(7);
  const camarilla = tags({ variant: "camarilla" });
  expect(camarilla).toContain("R4 " + String(Number((104 + (1.1 * 20) / 2).toFixed(2))));
});

test("registers once and survives a failing library", () => {
  const seen: string[] = [];
  registerPivots((d) => seen.push(d.id), (id) => seen.includes(id));
  registerPivots((d) => seen.push(d.id), (id) => seen.includes(id));
  expect(seen).toEqual([PIVOTS_ID]);
  expect(() => registerPivots(() => { throw new Error("nope"); }, () => false)).not.toThrow();
});
