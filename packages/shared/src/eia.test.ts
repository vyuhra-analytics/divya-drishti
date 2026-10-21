import { expect, test } from "bun:test";
import { parseEia, summarizeEia, type EiaPoint } from "./eia";

const resp = (rows: any[]) => ({ response: { total: rows.length, dateFormat: "YYYY-MM-DD", data: rows } });

test("parseEia reads string values, sorts oldest first, skips rows without a number", () => {
  const p = parseEia(
    resp([
      { period: "2026-10-09", series: "WCESTUS1", value: "421545", units: "thousand barrels" },
      { period: "2026-10-02", series: "WCESTUS1", value: 419000 },
      { period: "2026-09-25", value: null },
      { period: "bad", value: "1" },
    ]),
  );
  expect(p).toEqual([
    { period: "2026-10-02", value: 419000 },
    { period: "2026-10-09", value: 421545 },
  ]);
  expect(parseEia({ error: { code: "OVER_RATE_LIMIT" } })).toEqual([]);
});

/** a weekly series, one point per 7 days ending 2026-10-09, value = f(weeks back) */
const weekly = (n: number, f: (back: number) => number): EiaPoint[] =>
  Array.from({ length: n }, (_, i) => {
    const back = n - 1 - i;
    return { period: new Date(Date.UTC(2026, 9, 9) - back * 7 * 86_400_000).toISOString().slice(0, 10), value: f(back) };
  });

test("summarizeEia compares with last week, last year and the five-year average of the same week", () => {
  // 300 weeks: last week 100, this week 110, 52 weeks back 90, and 104/156/208/260 weeks back 80/70/60/50
  const pts = weekly(300, (b) => ({ 0: 110, 1: 100, 52: 90, 104: 80, 156: 70, 208: 60, 260: 50 })[b] ?? 0);
  const s = summarizeEia("WCESTUS1", pts);
  expect(s.latest).toEqual({ period: "2026-10-09", value: 110 });
  expect(s.change).toBe(10);
  expect(s.yoyChange).toBe(20);
  expect(s.fiveYearAvg).toBe((90 + 80 + 70 + 60 + 50) / 5);
  expect(s.vsFiveYear).toBe(110 - 70);
});

test("summarizeEia leaves out comparisons the history cannot support", () => {
  const short = summarizeEia("X", weekly(10, () => 5));
  expect(short.yoyChange).toBeUndefined();
  expect(short.vsFiveYear).toBeUndefined();
  expect(short.change).toBe(0);
  expect(summarizeEia("X", [])).toEqual({ id: "X" });
});
