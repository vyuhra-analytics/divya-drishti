import { expect, test } from "bun:test";
import { FVG_ID, fvgIndicator, registerFvg } from "./advFvg";

const bar = (i: number, low: number, high: number) => ({ time: i * 300, open: low, high, low, close: high, volume: 1 }) as never;
// bullish gap 102..105 formed at bar 2, filled at bar 4
const bars = [bar(0, 100, 102), bar(1, 102, 108), bar(2, 105, 110), bar(3, 106, 118), bar(4, 104, 109)];
const draw = (settings: Record<string, unknown>) => (fvgIndicator().draws!({ bars, settings } as never) as unknown as { from: { time: number; price: number }; to: { time: number }; text: string }[]);

test("open gaps are boxed to the last bar; filled ones are hidden unless asked for", () => {
  const open = draw({ min_size: 0 });
  expect(open).toHaveLength(0); // the only gap was touched at bar 4
  const all = draw({ min_size: 0, show_filled: true });
  expect(all).toHaveLength(1);
  expect(all[0].from).toEqual({ time: 300, price: 105 });
  expect(all[0].to.time).toBe(4 * 300);
});

test("a gap that is still open runs to the newest bar", () => {
  const open = (fvgIndicator().draws!({ bars: bars.slice(0, 4), settings: { min_size: 0 } } as never) as unknown as { to: { time: number }; text: string }[]);
  expect(open).toHaveLength(1);
  expect(open[0].to.time).toBe(3 * 300);
  expect(open[0].text).toBe("FVG");
});

test("registers once and survives a failing library", () => {
  const seen: string[] = [];
  registerFvg((d) => seen.push(d.id), (id) => seen.includes(id));
  registerFvg((d) => seen.push(d.id), (id) => seen.includes(id));
  expect(seen).toEqual([FVG_ID]);
  expect(() => registerFvg(() => { throw new Error("nope"); }, () => false)).not.toThrow();
});
