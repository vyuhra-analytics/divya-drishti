import { expect, test } from "bun:test";
import { BROKERS, brokerById, compareBrokers, DEFAULT_BROKER, matchBroker, normalizeRates } from "./brokers";
import { legCosts, UPSTOX_MCX_RATES } from "./costs";

const upstox = brokerById("upstox")!;
const zerodha = brokerById("zerodha")!;
const kotak = brokerById("kotakneo")!;
const groww = brokerById("groww")!;

test("the profiles: Upstox first and the default, each with its source and the date it was read; only Upstox is checked against the broker's own calculation", () => {
  expect(BROKERS.map((b) => b.id)).toEqual(["upstox", "zerodha", "kotakneo", "groww", "custom"]);
  expect(DEFAULT_BROKER).toBe("upstox");
  expect(new Set(BROKERS.map((b) => b.id)).size).toBe(BROKERS.length);
  for (const b of BROKERS.filter((x) => x.id !== "custom")) {
    expect(b.source.length).toBeGreaterThan(20);
    expect(b.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
  expect(upstox.verification).toBe("api");
  expect(zerodha.verification).toBe("published");
  expect(kotak.verification).toBe("published"); // the official page, which lists F&O but does not name MCX: the note says so
  expect(kotak.note).toMatch(/kotakneo\.com/);
  expect(brokerById("nope")).toBeUndefined();
});

test("only the brokerage rule differs between brokers: the statutory charges are the exchange's and the government's", () => {
  const statutory = ["cttFutures", "cttOptions", "exchangeFutures", "exchangeOptions", "sebi", "stampFutures", "stampOptions", "gst"] as const;
  for (const b of [zerodha, kotak, groww]) for (const k of statutory) expect([b.id, k, b.rates[k]]).toEqual([b.id, k, upstox.rates[k]]);
  expect(upstox.rates.brokerageFlat).toBe(30);
  expect(zerodha.rates).toMatchObject({ brokerageFlat: 20, brokeragePctFutures: 0.0003, brokeragePctOptions: 0 });
  expect(kotak.rates).toMatchObject({ brokerageFlat: 10, brokeragePctFutures: 0, brokeragePctOptions: 0 });
  expect(groww.rates).toMatchObject({ brokerageFlat: 20, brokeragePctFutures: 0, brokeragePctOptions: 0 });
  expect(groww.verification).toBe("published");
});

test("Zerodha's futures brokerage is the lower of Rs 20 and 0.03% of turnover; its options brokerage is Rs 20 flat", () => {
  const r = zerodha.rates;
  // a crude lot at 9,400: turnover Rs 9.4 lakh, 0.03% = Rs 282, so the Rs 20 cap applies
  expect(legCosts("future", "buy", 9400, 100, 1, r).brokerage).toBe(20);
  // a small order: Rs 40,000 of turnover, 0.03% = Rs 12, below the cap
  expect(legCosts("future", "buy", 400, 100, 1, r).brokerage).toBeCloseTo(12, 9);
  // options are flat Rs 20 whatever the premium
  expect(legCosts("option", "buy", 500, 100, 1, r).brokerage).toBe(20);
  expect(legCosts("option", "buy", 5, 100, 1, r).brokerage).toBe(20);
  // GST is charged on the brokerage that was actually charged
  const small = legCosts("future", "sell", 400, 100, 1, r);
  expect(small.gst).toBeCloseTo((small.brokerage + small.exchange + small.sebi) * 0.18, 9);
});

test("Upstox and Kotak Neo are flat per order: the amount does not move with the size", () => {
  for (const b of [upstox, kotak, groww]) {
    expect(legCosts("future", "buy", 9400, 100, 5, b.rates).brokerage).toBe(b.rates.brokerageFlat);
    expect(legCosts("option", "buy", 5, 100, 1, b.rates).brokerage).toBe(b.rates.brokerageFlat);
  }
});

test("compareBrokers prices the same trade at every broker, cheapest first, with Custom left out", () => {
  const out = compareBrokers("option", "buy", 500, 560, 100, 1); // one crude option lot bought at 500, sold at 560
  expect(out.map((c) => c.broker.id).sort()).toEqual(["groww", "kotakneo", "upstox", "zerodha"]);
  expect(out.map((c) => c.costs)).toEqual([...out.map((c) => c.costs)].sort((a, b) => a - b));
  expect(out[0].broker.id).toBe("kotakneo"); // Rs 10 a leg is the cheapest of the four here
  const byId = Object.fromEntries(out.map((c) => [c.broker.id, c]));
  expect(byId.upstox.costs - byId.zerodha.costs).toBeCloseTo(2 * 10 * 1.18, 6); // Rs 10 more brokerage a leg, plus 18% GST on it
  expect(byId.upstox.net).toBeCloseTo(560 * 100 - 500 * 100 - byId.upstox.costs, 6);
  expect(byId.zerodha.breakeven).toBeCloseTo(byId.zerodha.costs / 100, 9);
});

test("matchBroker names the profile whose rates are exactly these, and nothing once a rate has been edited", () => {
  expect(matchBroker(zerodha.rates)?.id).toBe("zerodha");
  expect(matchBroker(kotak.rates)?.id).toBe("kotakneo");
  expect(matchBroker(groww.rates)?.id).toBe("groww");
  expect(matchBroker(UPSTOX_MCX_RATES)?.id).toBe("upstox");
  expect(matchBroker({ ...zerodha.rates, brokerageFlat: 21 })).toBeUndefined();
});

test("normalizeRates fills a saved object that lacks the new fields and upgrades an untouched old Upstox table", () => {
  const oldSaved = { brokerageFlat: 20, cttFutures: 0.0001, cttOptions: 0.0005, exchangeFutures: 0.000021, exchangeOptions: 0.000418, sebi: 0.000001, stampFutures: 0.00002, stampOptions: 0.00003, gst: 0.18 };
  expect(normalizeRates(oldSaved)).toEqual(UPSTOX_MCX_RATES); // never edited: takes the current defaults (Rs 30)
  expect(normalizeRates({ ...oldSaved, brokerageFlat: 25 })).toEqual({ ...UPSTOX_MCX_RATES, brokerageFlat: 25, brokeragePctFutures: 0, brokeragePctOptions: 0 });
  expect(normalizeRates(undefined)).toEqual(UPSTOX_MCX_RATES);
  expect(normalizeRates(null)).toEqual(UPSTOX_MCX_RATES);
  expect(normalizeRates(zerodha.rates)).toEqual(zerodha.rates);
  expect(normalizeRates(groww.rates)).toEqual(groww.rates); // Rs 20 flat with the new fields is Groww, not the old Upstox default
});

test("the profiles load whichever module is imported first (costs and the package index import each other)", () => {
  for (const first of ["./costs.ts", "./brokers.ts", "./index.ts"]) {
    const run = Bun.spawnSync(["bun", "-e", `await import("${first}"); const b = await import("./brokers.ts"); console.log(b.BROKERS.map((x) => x.rates.brokerageFlat).join(","))`], { cwd: import.meta.dir });
    expect([first, run.stderr.toString().trim(), run.stdout.toString().trim()]).toEqual([first, "", "30,20,10,20,30"]);
  }
});
