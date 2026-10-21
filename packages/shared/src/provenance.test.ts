import { expect, test } from "bun:test";
import { computedProvenance, describeProvenance, FRESHNESS_BUDGET_MS, quoteProvenance, withinBudget } from "./provenance";

const NOW = 1_800_000_000_000;
const q = { source: "upstox" as const, time: NOW - 2000, delayedBy: 0 };

test("quoteProvenance names the source, as-of time and quality from the feed and session state", () => {
  expect(quoteProvenance(q, "live")).toEqual({ source: "upstox", quality: "live", asOf: NOW - 2000 });
  expect(quoteProvenance({ ...q, source: "yahoo", delayedBy: 600 }, "live").quality).toBe("delayed");
  expect(quoteProvenance(q, "stale").quality).toBe("stale");
  expect(quoteProvenance(q, "closed").quality).toBe("closed"); // a closed market wins over everything
  expect(quoteProvenance({ ...q, source: "yahoo", delayedBy: 600 }, "closed").quality).toBe("closed");
});

test("a conflict between feeds travels with the quote's provenance", () => {
  const p = quoteProvenance({ ...q, drift: { between: ["tradingview", "upstox"], pct: 0.31, ticks: 29 } }, "live");
  expect(p.conflict).toEqual({ between: ["tradingview", "upstox"], pct: 0.31, ticks: 29 });
  expect(quoteProvenance(q, "live").conflict).toBeUndefined();
});

test("freshness budgets: weekly reports tolerate their cadence, quotes do not", () => {
  expect(withinBudget("quote", NOW - 30_000, NOW)).toBe(true);
  expect(withinBudget("quote", NOW - 90_000, NOW)).toBe(false);
  const day = 86_400_000;
  expect(withinBudget("positioning", NOW - 10 * day, NOW)).toBe(true); // Tuesday data on the next Friday: due, not late
  expect(withinBudget("positioning", NOW - 13 * day, NOW)).toBe(false); // a missed release
  expect(withinBudget("inventory", NOW - 12 * day, NOW)).toBe(true); // week ending Friday 9 Oct, still the latest on release day 21 Oct
  expect(withinBudget("balances", NOW - 200 * day, NOW)).toBe(true); // India reports about 6 months late
  expect(FRESHNESS_BUDGET_MS.inventory).toBe(14 * day);
});

test("describeProvenance reads in plain words", () => {
  expect(describeProvenance({ source: "upstox", quality: "live", asOf: NOW - 2000 }, NOW)).toBe("upstox, live, as of 2s ago");
  expect(describeProvenance({ source: "eia", quality: "published", asOf: NOW - 3 * 86_400_000 }, NOW)).toBe("eia, published, as of 3d ago");
  expect(describeProvenance({ source: "upstox", quality: "live", asOf: NOW, conflict: { between: ["tradingview", "upstox"], pct: 0.2, ticks: 19 } }, NOW)).toBe("upstox, live, as of 0s ago; tradingview and upstox differ by 0.20% (19 ticks)");
  expect(computedProvenance(5)).toEqual({ source: "computed", quality: "computed", asOf: 5 });
});
