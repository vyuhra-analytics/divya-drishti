import { expect, test } from "bun:test";
import type { BriefingContext } from "./briefing";
import { buildRecap } from "./recap";

const base = (over: Partial<BriefingContext> = {}): BriefingContext => ({
  symbol: "NYMEX:CL",
  name: "WTI Crude Oil",
  asOf: "2026-10-21T10:00:00Z",
  provenance: { price: { source: "upstox", quality: "live", asOf: 0 }, technicals: { source: "computed", quality: "computed", asOf: 0 } },
  price: 98.9,
  changePct: 1.19,
  day: { open: 97.5, high: 99.2, low: 97.4, prevClose: 97.74 },
  book: {},
  technicals: { timeframe: "5m", rsi14: 72.4, ema20: 98.5, ema50: 98.0 },
  stats: { realizedVol20: 31.2, volPercentile: 91, regime: "trending" },
  news: [],
  events: [],
  ...over,
});

test("buildRecap writes the headline and the trend, momentum and volatility lines from the numbers", () => {
  const r = buildRecap(base());
  expect(r.headline).toBe("WTI Crude Oil is at 98.90 (+1.19% on the day), near the day high.");
  expect(r.lines[0]).toBe("On the 5m chart price is above both its 20 and 50 period averages (uptrend); RSI 72 is overbought.");
  expect(r.lines[1]).toBe("Volatility is high for the loaded history (91th percentile, 31% annualised), and price has been trending.");
});

test("buildRecap adds curve, positioning, inventories, options, next release and news when given", () => {
  const r = buildRecap(
    base({
      options: { expiry: "2026-11-19", pcr: 1.23, maxPain: 9400 },
      events: [
        { title: "EIA crude inventories", inMin: 200, forecast: "-1.2M", previous: "-8.6M" },
        { title: "later", inMin: 900 },
      ],
      news: [{ n: 1, title: "Hormuz traffic stays thin", source: "Reuters", ageMin: 25, tags: ["crude"] }],
    }),
    {
      curve: { shape: "backwardation", m1m2: -1.78, m1Last: -14.2 },
      cot: { name: "WTI", net: 40574, change: -13024, percentile: 14 },
      stocks: [{ label: "US crude stocks", change: -8557, vsFiveYear: -10020 }],
    },
  );
  const text = r.lines.join("\n");
  expect(text).toContain("The futures curve is in backwardation: the next month is -1.78 against the front (later months cheaper, a tight market).");
  expect(text).toContain("Speculators are net long 40,574 contracts in WTI, the 14th percentile of the last three years, cutting 13,024 on the week.");
  expect(text).toContain("US crude stocks drew 8,557 thousand barrels last week, 10,020 thousand below the five-year average.");
  expect(text).toContain("Options: put/call ratio 1.23, max pain 9400.");
  expect(text).toContain("Next release: EIA crude inventories in 3 h 20 min (forecast -1.2M, previous -8.6M).");
  expect(text).toContain('1 headline in the last 3 hours; newest: "Hormuz traffic stays thin" (Reuters, 25 min ago).');
});

test("buildRecap leaves out whatever is missing and handles a mid-range, mixed-trend market", () => {
  const r = buildRecap(base({ changePct: undefined, price: 98.3, day: { high: 99.2, low: 97.4 }, technicals: { timeframe: "1h", ema20: 98.0, ema50: 99.0 }, stats: {} }));
  expect(r.headline).toBe("WTI Crude Oil is at 98.30, mid-range for the day.");
  expect(r.lines).toEqual(["On the 1h chart price is between its 20 and 50 period averages (no clear trend)."]);
  expect(buildRecap(base({ technicals: { timeframe: "5m" }, stats: {} })).lines).toEqual([]);
});

test("buildRecap says so when the price is closed, behind or disputed", () => {
  const p = (price: object) => base({ provenance: { price: { source: "yahoo", quality: "live", asOf: 0, ...price } as never, technicals: { source: "computed", quality: "computed", asOf: 0 } } });
  expect(buildRecap(p({ quality: "closed" })).lines[0]).toBe("The market is closed: this is the last price, not a live one.");
  expect(buildRecap(p({ quality: "stale" })).lines[0]).toBe("The feed has gone quiet: this price may be behind the market.");
  expect(buildRecap(p({ quality: "delayed" })).lines[0]).toBe("This price comes from yahoo, which runs behind the exchange.");
  expect(buildRecap(p({ conflict: { between: ["tradingview", "upstox"], pct: 0.31, ticks: 29 } })).lines[0]).toBe("Two live feeds disagree: tradingview and upstox differ by 0.31%, so treat the price as disputed.");
  expect(buildRecap(p({})).lines[0]).toMatch(/^On the 5m chart/); // live and undisputed: nothing added
});
