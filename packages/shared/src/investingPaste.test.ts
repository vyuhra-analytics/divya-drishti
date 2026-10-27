import { expect, test } from "bun:test";
import { parseInvestingPaste, parseMillions } from "./investingPaste";

const NOW = Date.UTC(2026, 9, 27);

test("parseMillions reads M and K figures and refuses the rest", () => {
  expect(parseMillions("-3.060M")).toBe(-3.06);
  expect(parseMillions("1,234.5K")).toBeCloseTo(1.2345);
  expect(parseMillions("")).toBeUndefined();
  expect(parseMillions("-")).toBeUndefined();
});

test("a tab-separated row keeps a blank actual in place, so a future release's forecast is not taken for the actual", () => {
  const out = parseInvestingPaste("Oct 28, 2026\t14:30\t\t-0.300M\t-3.060M\nOct 21, 2026\t14:30\t-3.060M\t-0.100M\t-8.557M", "UTC", NOW);
  expect(out).toEqual([
    { at: Date.UTC(2026, 9, 21, 14, 30), actual: -3.06, forecast: -0.1, previous: -8.557 },
    { at: Date.UTC(2026, 9, 28, 14, 30), actual: undefined, forecast: -0.3, previous: -3.06 },
  ]);
});

test("space-separated rows, headings and junk lines", () => {
  const out = parseInvestingPaste("Release date Time Actual Forecast Previous\nShow More\nFeb 10, 2016 15:30 -0.754M 3.550M 7.792M", "UTC", NOW);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ actual: -0.754, forecast: 3.55, previous: 7.792 });
});

test("New York wall times become the right instant across daylight saving", () => {
  const [w, s] = parseInvestingPaste("Jan 13, 2016 10:30 1M 1M 1M\nJul 13, 2016 10:30 1M 1M 1M", "America/New_York", NOW);
  expect(w.at).toBe(Date.UTC(2016, 0, 13, 15, 30));
  expect(s.at).toBe(Date.UTC(2016, 6, 13, 14, 30));
});
