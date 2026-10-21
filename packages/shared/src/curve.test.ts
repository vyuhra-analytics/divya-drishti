import { expect, test } from "bun:test";
import { curveCodes, parseCurve, summarizeCurve } from "./curve";

const NOW = Date.UTC(2026, 9, 21); // 21 Oct 2026

test("curveCodes walks the months across the year end", () => {
  expect(curveCodes("NYMEX:CL", NOW, 4)).toEqual(["NYMEX:CLV2026", "NYMEX:CLX2026", "NYMEX:CLZ2026", "NYMEX:CLF2027"]);
  expect(curveCodes("MCX:CRUDEOIL", NOW, 1)).toEqual(["MCX:CRUDEOILV2026"]);
});

const scan = {
  data: [
    { s: "NYMEX:CLF2027", d: [97.27, 17064, 20261221] },
    { s: "NYMEX:CLX2026", d: [101.79, 16793, 20261020] }, // expired yesterday: TradingView still answers
    { s: "NYMEX:CLZ2026", d: [99.03, 54204, 20261120] },
    { s: "NYMEX:CLG2027", d: [null, null, 20270120] }, // no price
    { s: "NYMEX:CLH2027", d: [96, 10, "bad"] },
  ],
};

test("parseCurve sorts nearest first, drops expired and unpriced rows and adds spreads", () => {
  const p = parseCurve(scan, NOW);
  expect(p.map((x) => x.code)).toEqual(["NYMEX:CLZ2026", "NYMEX:CLF2027"]);
  expect(p[0].spread).toBeUndefined();
  expect(p[1].spread).toBeCloseTo(97.27 - 99.03, 9);
  expect(p[0].expiry).toBe(Date.UTC(2026, 10, 20));
  expect(parseCurve({}, NOW)).toEqual([]);
});

test("summarizeCurve names the shape and the annualised roll", () => {
  const down = summarizeCurve(parseCurve(scan, NOW))!;
  expect(down.shape).toBe("backwardation");
  expect(down.m1m2).toBeCloseTo(-1.76, 9);
  expect(down.rollYieldPct!).toBeGreaterThan(0); // front dearer than next: positive roll
  const up = summarizeCurve([
    { code: "a", expiry: NOW, price: 100 },
    { code: "b", expiry: NOW + 30 * 86_400_000, price: 102 },
  ])!;
  expect(up.shape).toBe("contango");
  expect(up.rollYieldPct!).toBeLessThan(0);
  expect(summarizeCurve([{ code: "a", expiry: NOW, price: 1 }])).toBeUndefined();
});
