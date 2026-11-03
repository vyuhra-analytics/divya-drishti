import { expect, test } from "bun:test";
import { startAxisTags, wantedTags, type AxisTag } from "./advAxisTags";

const tag = (text: string, price: number): AxisTag => ({ text, price, color: "#fff" });
function fakeChart(tags: () => AxisTag[], visible = true) {
  const lines = new Set<{ opts: Record<string, unknown> }>();
  return {
    lines,
    indicators: () => [{ _store: { axisTags: tags() }, _visible: visible }],
    addPriceLine: (opts: Record<string, unknown>) => {
      const l = { opts };
      lines.add(l);
      return l;
    },
    removePrimitive: (l: { opts: Record<string, unknown> }) => void lines.delete(l),
  };
}

test("a hidden study wants no tags, and duplicates collapse", () => {
  expect(wantedTags(fakeChart(() => [tag("PDH 9", 9)], false))).toEqual([]);
  expect(wantedTags(fakeChart(() => [tag("PDH 9", 9), tag("PDH 9", 9)]))).toHaveLength(1);
});

test("tags follow the study: added with their text, replaced when the price moves, all removed on stop", () => {
  let now = [tag("DH 120", 120)];
  const chart = fakeChart(() => now);
  const stop = startAxisTags(chart as never, 5);
  expect([...chart.lines].map((l) => l.opts.label)).toEqual(["DH 120"]);
  return new Promise<void>((done) => {
    now = [tag("DH 125", 125)];
    setTimeout(() => {
      expect([...chart.lines].map((l) => l.opts.label)).toEqual(["DH 125"]);
      stop();
      expect(chart.lines.size).toBe(0);
      done();
    }, 40);
  });
});
