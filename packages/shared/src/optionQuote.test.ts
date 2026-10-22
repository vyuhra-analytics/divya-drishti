import { expect, test } from "bun:test";
import { OPTION_KEY, optionLagMs, optionQuoteProblem, parseOptionFeed } from "./optionQuote";

// A decoded entry copied from a live Upstox feed on 2026-10-22 (CRUDEOIL 9450 CE, 17 Nov 26, mode full), protobuf already turned into a plain object.
const live = {
  fullFeed: {
    marketFF: {
      ltpc: { ltp: 463.3, ltt: 1792683058000, ltq: 200, cp: 394.8 },
      marketLevel: {
        bidAskQuote: [
          { bidQ: 1, bidP: 462.1, askQ: 1, askP: 463.6 },
          { bidQ: 2, bidP: 461.9, askQ: 3, askP: 463.9 },
          { bidQ: 4, bidP: 461.5, askQ: 2, askP: 464.4 },
          { bidQ: 0, bidP: 0, askQ: 5, askP: 465.0 },
          { bidQ: 0, bidP: 0, askQ: 0, askP: 0 },
        ],
      },
      optionGreeks: { delta: 0.4904, theta: -9.9397, gamma: 0.0003, vega: 9.9518, rho: 2.9422 },
      atp: 441.2,
      vtt: 17488,
      oi: 1483,
      iv: 0.5218505859375,
    },
  },
  requestMode: "full_d5",
};

test("a live full-mode option entry becomes a quote with depth, OI, volume, IV in percent and greeks", () => {
  const q = parseOptionFeed("MCX_FO|582939", live, 1792683058400)!;
  expect(q).toMatchObject({ key: "MCX_FO|582939", price: 463.3, time: 1792683058000, recvAt: 1792683058400, prevClose: 394.8, bid: 462.1, ask: 463.6, bidQty: 1, askQty: 1, oi: 1483, volume: 17488, atp: 441.2, delta: 0.4904, theta: -9.9397, gamma: 0.0003, vega: 9.9518, rho: 2.9422 });
  expect(q.iv).toBe(52.19); // the feed sends a fraction: 0.52185 → 52.19 %
  expect(q.depth).toHaveLength(4); // the empty fifth level and the half-empty fourth keep only their real side
  expect(q.depth![3]).toEqual({ bidP: undefined, bidQ: undefined, askP: 465, askQ: 5 });
  expect(optionQuoteProblem(q)).toBeUndefined();
  expect(optionLagMs(q)).toBe(400);
});

test("an entry with no usable last price is not a quote (never a zero price)", () => {
  expect(parseOptionFeed("MCX_FO|1", {}, 1)).toBeUndefined();
  expect(parseOptionFeed("MCX_FO|1", { fullFeed: { marketFF: { ltpc: { ltp: 0, ltt: 5 } } } }, 1)).toBeUndefined();
  expect(parseOptionFeed("MCX_FO|1", { fullFeed: { marketFF: { ltpc: { ltp: "abc" } } } }, 1)).toBeUndefined();
});

test("a future entry (no greeks, no IV) still parses, with greeks left undefined", () => {
  const q = parseOptionFeed("MCX_FO|573422", { fullFeed: { marketFF: { ltpc: { ltp: 9330, ltt: 1, cp: 9208 }, oi: 13332, vtt: 34120, marketLevel: { bidAskQuote: [{ bidQ: 9, bidP: 9329, askQ: 1, askP: 9330 }] } } } }, 10)!;
  expect(q.delta).toBeUndefined();
  expect(q.iv).toBeUndefined();
  expect(q.bid).toBe(9329);
});

test("the option_greeks mode's shape is read too", () => {
  const q = parseOptionFeed("MCX_FO|9", { firstLevelWithGreeks: { ltpc: { ltp: 12.5, ltt: 7 }, optionGreeks: { delta: -0.4 }, vtt: 3, oi: 9, iv: 0.3 } }, 8)!;
  expect(q).toMatchObject({ price: 12.5, delta: -0.4, volume: 3, oi: 9, iv: 30 });
});

test("quote problems: impossible values are refused, a crossed book is allowed", () => {
  const base = parseOptionFeed("MCX_FO|582939", live, 1792683058400)!;
  expect(optionQuoteProblem({ ...base, price: 0 })).toBe("non-positive price");
  expect(optionQuoteProblem({ ...base, volume: -1 })).toBe("negative volume");
  expect(optionQuoteProblem({ ...base, oi: -5 })).toBe("negative open interest");
  expect(optionQuoteProblem({ ...base, delta: 1.4 })).toBe("delta outside -1 to 1");
  expect(optionQuoteProblem({ ...base, bid: 470, ask: 463 })).toBeUndefined();
});

test("lag is the time from the exchange trade to our receipt, and unknown when the trade time is not credible", () => {
  const q = parseOptionFeed("MCX_FO|582939", live, 1792683059000)!;
  expect(optionLagMs(q)).toBe(1000);
  expect(optionLagMs({ ...q, recvAt: q.time - 10_000 })).toBeUndefined(); // the exchange clock ahead of ours
  expect(optionLagMs({ ...q, recvAt: q.time + 10 * 60_000 })).toBeUndefined(); // an hour-old "trade": not a lag measurement
  expect(optionLagMs({ ...q, recvAt: q.time - 500 })).toBe(0);
});

test("only Upstox MCX derivative keys pass the key check", () => {
  expect(OPTION_KEY.test("MCX_FO|582939")).toBe(true);
  for (const bad of ["NSE_FO|12345", "MCX_FO|", "MCX_FO|12", "MCX_FO|582939 ", "MCX_FO|582939,MCX_FO|1", "x", "MCX_FO|58293912345"]) expect(OPTION_KEY.test(bad)).toBe(false);
});
