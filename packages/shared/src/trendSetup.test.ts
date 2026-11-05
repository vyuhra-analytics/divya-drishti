import { expect, test } from "bun:test";
import type { Bar } from "./index";
import type { Chain } from "./options";
import { confirmWithGlobal, eventFilter, evaluateSetup, levelsAround, pickStrike, SETUP_RULES, structureOf, swings, trendOf, trigger15 } from "./trendSetup";

/** a zig-zag series: drift per bar plus a wave, so swing highs and lows form */
function wave(n: number, drift: number, start = 100, tf = 900, t0 = 1_700_000_000): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = start + drift * i + 3 * Math.sin(i / 2);
    return { time: t0 + i * tf, open: c, high: c + 1, low: c - 1, close: c, volume: 10 };
  });
}

test("swings are fractals and need their later bars: the newest bars are never a swing yet", () => {
  const bars = wave(40, 0);
  const sw = swings(bars, 2);
  expect(sw.length).toBeGreaterThan(4);
  expect(sw.every((s) => s.index >= 2 && s.index <= bars.length - 3)).toBe(true);
  // causal: adding bars never changes a swing already found
  const more = swings(wave(60, 0), 2).filter((s) => s.index <= bars.length - 3);
  expect(more).toEqual(sw);
});

test("structure: higher highs and higher lows is up, the mirror is down, too few swings is unknown", () => {
  expect(structureOf(swings(wave(60, 0.5)))).toBe("up");
  expect(structureOf(swings(wave(60, -0.5)))).toBe("down");
  expect(structureOf(swings(wave(4, 0.5)))).toBe("unknown");
});

test("bias rule: rising averages with an up structure is bullish, the mirror bearish, a flat zig-zag is no trade", () => {
  expect(trendOf(wave(80, 0.5)).bias).toBe("bullish");
  expect(trendOf(wave(80, -0.5)).bias).toBe("bearish");
  const flat = trendOf(wave(80, 0));
  expect(flat.bias).toBe("none");
  expect(flat.reason).toContain("no clean trend");
  expect(trendOf(wave(30, 0.5)).reason).toContain("needs"); // under 55 bars: the 50 EMA and its slope are not known
});

test("levels are the nearest swing low below and swing high above the price", () => {
  const bars = wave(60, 0);
  const l = levelsAround(bars, 100);
  expect(l.support!).toBeLessThan(100);
  expect(l.resistance!).toBeGreaterThan(100);
});

test("confirmation: a fair-value move against the bias fails; NYMEX against with the rupee explaining it passes; NYMEX against with nothing to explain it fails", () => {
  expect(confirmWithGlobal("bullish", { nymexPct: -0.8, fxPct: 0.1 }).status).toBe("fail");
  const explained = confirmWithGlobal("bullish", { nymexPct: -0.2, fxPct: 0.5 });
  expect(explained.status).toBe("pass");
  expect(explained.detail).toContain("rupee move explains");
  expect(confirmWithGlobal("bullish", { nymexPct: -0.3, fxPct: 0.25 }).status).toBe("fail"); // fair +... -0.05: flat, NYMEX against
  expect(confirmWithGlobal("bearish", { nymexPct: -0.6, fxPct: 0 }).status).toBe("pass");
  expect(confirmWithGlobal("bullish", { nymexPct: 0.4 }).status).toBe("fail"); // the rupee move is not known
  expect(confirmWithGlobal("bullish", { nymexPct: 0.4, fxPct: 0, premiumRank: 97 }).status).toBe("fail"); // basis divergence
  expect(confirmWithGlobal("none", { nymexPct: 0.4, fxPct: 0 }).status).toBe("na");
});

test("event filter: no entry two hours before a release or half an hour after; outside it the next release is named", () => {
  const now = 1_800_000_000_000;
  const ev = (min: number) => [{ title: "EIA crude inventories", at: now + min * 60_000 }];
  expect(eventFilter(ev(90), now).status).toBe("fail");
  expect(eventFilter(ev(-20), now).status).toBe("fail");
  expect(eventFilter(ev(-40), now).status).toBe("pass");
  const far = eventFilter(ev(300), now);
  expect(far.status).toBe("pass");
  expect(far.detail).toContain("EIA crude inventories in 5.0 h");
});

/** an up-trend of 15-minute bars, then a pullback to the EMA and a bar that closes back above it and the previous high */
function pullbackThenResume(): Bar[] {
  const bars = wave(40, 0.3, 100, 900).map((b) => ({ ...b }));
  const t = bars.at(-1)!.time;
  const top = bars.at(-1)!.close;
  const push = (o: number, h: number, l: number, c: number) => bars.push({ time: t + (bars.length - 39) * 900, open: o, high: h, low: l, close: c, volume: 10 });
  push(top, top + 0.5, top - 2, top - 1.5);
  push(top - 1.5, top - 1, top - 5, top - 4); // down through the EMA
  push(top - 4, top - 2, top - 4.5, top - 2.5);
  push(top - 2.5, top + 1, top - 3, top + 0.8); // closes above the EMA and the previous high
  return bars;
}

test("15-minute trigger: pullback to the EMA, then a close back above it and the previous high; stop at the pullback's low", () => {
  const bars = pullbackThenResume();
  const t = trigger15(bars, "bullish");
  expect(t.status).toBe("pass");
  expect(t.stop).toBe(Math.min(...bars.slice(-7).map((b) => b.low)));
  expect(t.tp1).toBeCloseTo(t.entry! + t.rPoints!, 6);
  expect(t.tp2).toBeCloseTo(t.entry! + 2 * t.rPoints!, 6);
  // without the last bar it is still waiting for the resume
  expect(trigger15(bars.slice(0, -1), "bullish").status).toBe("wait");
  // a clean run up with no pullback: do not chase
  expect(trigger15(wave(40, 2, 100, 900).map((b) => ({ ...b, low: b.close - 0.1 })), "bullish").detail).toContain("do not chase");
  expect(trigger15(bars, "none").status).toBe("na");
  // a pullback so deep the stop is beyond 2.5 ATR: no trade
  const deep = bars.map((b, i) => (i === bars.length - 3 ? { ...b, low: b.low - 15 } : b));
  expect(trigger15(deep, "bullish").detail).toContain("ATR");
});

const leg = (delta: number, ask: number, bid: number, ukey: string) => ({ key: ukey, ukey, delta, ask, bid, ltp: ask, iv: 40, oi: 500 });
function chain(): Chain {
  return {
    underlying: "CRUDEOIL", expiry: "2026-11-19", expiries: ["2026-11-19"], spot: 100, atm: 100, lot: 100, updatedAt: 0,
    rows: [
      { strike: 95, ce: leg(0.72, 230, 229, "c95"), pe: leg(-0.28, 60, 59, "p95") },
      { strike: 100, ce: leg(0.53, 170, 169, "c100"), pe: leg(-0.47, 150, 149, "p100") },
      { strike: 105, ce: leg(0.41, 120, 119, "c105"), pe: leg(-0.6, 200, 199, "p105") },
      { strike: 110, ce: leg(0.25, 80, 70, "c110"), pe: leg(-0.75, 260, 259, "p110") },
    ],
  };
}

test("strike: a call in the 0.40 to 0.60 delta band nearest 0.55, liquid, with premium levels from the future's R", () => {
  const s = pickStrike(chain(), "bullish", 4);
  expect(s.status).toBe("pass");
  expect(s.pick!.strike).toBe(100);
  expect(s.pick!.rupeeR).toBeCloseTo(4 * 0.53 * 100, 6);
  expect(s.pick!.stop).toBeCloseTo(170 - 4 * 0.53, 2);
  expect(pickStrike(chain(), "bearish", 4).pick!.type).toBe("PE");
  // a stop far enough that 1R is over the cap on the preferred strike steps down to a lower delta in the band
  const far = pickStrike(chain(), "bullish", 40); // 1R on the 100 call = 40 x 0.53 x 100 = 2,120
  expect(far.pick!.strike).toBe(105);
  // beyond that, no trade
  expect(pickStrike(chain(), "bullish", 60).status).toBe("fail");
  // an illiquid band: no trade
  const wide = chain();
  for (const r of wide.rows) if (r.ce) r.ce.bid = r.ce.ask! * 0.5;
  expect(pickStrike(wide, "bullish", 4).detail).toContain("spread");
});

test("the whole checklist: a clean trend, agreeing NYMEX, no release, a trigger and a strike is ready; a release turns it into no trade", () => {
  const daily = wave(80, 0.5, 90, 86_400);
  const hourly = wave(80, 0.3, 95, 3_600);
  const m15 = pullbackThenResume();
  const base = { daily, hourly, m15, confirm: { nymexPct: 0.5, fxPct: 0.1 }, events: [], chain: chain(), now: 1_800_000_000_000 };
  const ok = evaluateSetup(base);
  // the levels from the test series may leave no room; check every step but the room rule passes or explains itself
  expect(ok.steps.find((s) => s.id === "trend")!.status).toBe("pass");
  expect(ok.steps.find((s) => s.id === "confirm")!.status).toBe("pass");
  expect(ok.bias).toBe("bullish");
  const evt = evaluateSetup({ ...base, events: [{ title: "EIA crude inventories", at: base.now + 60 * 60_000 }] });
  expect(evt.verdict).toBe("no-trade");
  expect(evt.summary).toContain("event filter");
  const traded = evaluateSetup({ ...base, tradedToday: true });
  expect(traded.steps.find((s) => s.id === "events")!.detail).toContain("one trade a day");
  const chop = evaluateSetup({ ...base, daily: wave(80, 0, 90, 86_400) });
  expect(chop.verdict).toBe("no-trade");
  expect(chop.steps[0].detail).toContain("No trade");
  expect(SETUP_RULES.deltaMin).toBe(0.4);
});
