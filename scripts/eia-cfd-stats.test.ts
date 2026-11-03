import { expect, test } from "bun:test";
import { bootstrapCI, randomSideP, summarizeR } from "./eia-cfd-stats";

test("summary: mean, win rate, profit factor and drawdown in R", () => {
  const s = summarizeR([1, -1, 2, -0.5, -0.5]);
  expect(s).toMatchObject({ n: 5, winRate: 0.4, maxDrawdown: 1 });
  expect(s.mean).toBeCloseTo(0.2, 10);
  expect(s.profitFactor).toBeCloseTo(3 / 2, 10);
});

test("bootstrap is repeatable and needs 5 trades", () => {
  expect(bootstrapCI([1, 2, 3])).toBeUndefined();
  const xs = [1, -1, 2, 0.5, -0.2, 1.1];
  expect(bootstrapCI(xs, 500, 7)).toEqual(bootstrapCI(xs, 500, 7));
});

test("random-side test: a rule that always picks the better side beats chance, a coin-flip rule does not", () => {
  const good = Array.from({ length: 60 }, (_, i) => ({ long: i % 2 ? 1 : -1, short: i % 2 ? -1 : 1, side: (i % 2 ? "long" : "short") as "long" | "short" }));
  expect(randomSideP(good)!.p).toBeLessThan(0.01);
  const coin = good.map((d, i) => ({ ...d, side: (i % 3 ? "long" : "short") as "long" | "short" }));
  expect(randomSideP(coin)!.p).toBeGreaterThan(0.05);
  expect(randomSideP([])).toBeUndefined();
});
