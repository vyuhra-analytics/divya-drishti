import { expect, test } from "bun:test";
import { optionLegFor } from "./optionSignal";
import type { Chain, OptionLeg } from "./options";

const leg = (delta: number, ask: number, key: string): OptionLeg => ({ key, ukey: key, ask, ltp: ask, delta, theta: -5, iv: 40, oi: 1000, volume: 50 });
// strike, |delta|, premium per unit; one lot = 100 units
const chain = (rows: [number, number, number][]): Chain => ({
  underlying: "CRUDEOIL",
  expiry: "2026-11-17",
  expiries: [],
  atm: 9600,
  lot: 100,
  updatedAt: 0,
  rows: rows.map(([strike, delta, ask]) => ({ strike, ce: leg(delta, ask, `MCX_FO|${strike}1`), pe: leg(-delta, ask, `MCX_FO|${strike}2`) })),
});
const base = chain([[9500, 0.62, 240], [9550, 0.57, 200], [9600, 0.52, 170], [9650, 0.46, 140], [9700, 0.4, 110]]);

test("a long is a call at the money, with the premium levels from the future's R, TP2 distance and delta", () => {
  const { leg: l } = optionLegFor({ side: "long", entry: 9600, rPoints: 30, tp2: 9660 }, base, "CRUDEOIL");
  expect(l).toMatchObject({ type: "CE", strike: 9600, expiry: "2026-11-17", key: "MCX_FO|96001", units: 100, premium: 170, delta: 0.52, cost: 17000, label: "CRUDEOIL 9600 CE 2026-11-17" });
  expect(l!.rPremium).toBeCloseTo(15.6, 6); // 30 x 0.52
  expect(l!.rupeeR).toBe(1560);
  expect(l!.stop).toBeCloseTo(154.4, 6);
  expect(l!.tp1).toBeCloseTo(185.6, 6);
  expect(l!.tp2).toBeCloseTo(201.2, 6); // the future's 60 points to TP2 x 0.52
});

test("a short is a put, and USIB's trail is carried over through the delta", () => {
  const { leg: l } = optionLegFor({ side: "short", entry: 9600, rPoints: 30, trail: 20 }, base, "CRUDEOIL");
  expect(l).toMatchObject({ type: "PE", strike: 9600, key: "MCX_FO|96002" });
  expect(l!.trail).toBeCloseTo(10.4, 6);
  expect(l!.tp2).toBeCloseTo(170 + 60 * 0.52, 6); // no TP2 given: 2R
});

test("when 1R on the money strike is over the loss cap a lower-delta strike is taken, and when none fits there is no leg and a reason", () => {
  const { leg: l, reason } = optionLegFor({ side: "long", entry: 9600, rPoints: 40 }, base, "CRUDEOIL"); // 40 x 0.52 x 100 = 2,080 > 2,000
  expect(l!.strike).toBe(9650);
  expect(reason).toContain("lower-delta");
  const none = optionLegFor({ side: "long", entry: 9600, rPoints: 90 }, base, "CRUDEOIL");
  expect(none.leg).toBeUndefined();
  expect(none.reason).toContain("No trade");
});

test("no R, no chain, or a stop that would be under zero each give no leg and say why", () => {
  expect(optionLegFor({ side: "long" }, base, "CRUDEOIL").reason).toContain("no R");
  expect(optionLegFor({ side: "long", rPoints: 10 }, undefined, "CRUDEOIL").leg).toBeUndefined();
  const cheap = chain([[9700, 0.5, 4]]);
  const r = optionLegFor({ side: "long", rPoints: 10 }, cheap, "CRUDEOIL"); // 1R = 5 premium points on a 4 premium
  expect(r.leg).toBeUndefined();
  expect(r.reason).toContain("as large as its premium");
});

import { tradingExpiry } from "./optionSignal";

test("the expiry to trade is the nearest, unless it is within 3 days of its last minute (23:30 IST on the day), then the next", () => {
  const list = ["2026-11-20", "2026-12-23", "2027-01-21"];
  const at = (iso: string) => Date.parse(iso);
  expect(tradingExpiry(list, at("2026-10-29T16:00:00+05:30"))).toBe("2026-11-20");
  expect(tradingExpiry(list, at("2026-11-17T20:00:00+05:30"))).toBe("2026-11-20"); // 3 days and 3.5 hours left: still more than 3
  expect(tradingExpiry(list, at("2026-11-17T23:00:00+05:30"))).toBe("2026-11-20"); // 3 days and 30 minutes left: still more than 3
  expect(tradingExpiry(list, at("2026-11-17T23:30:00+05:30"))).toBe("2026-12-23"); // exactly 3 days: within 3 days, so the next
  expect(tradingExpiry(list, at("2026-11-19T10:00:00+05:30"))).toBe("2026-12-23");
  expect(tradingExpiry(["2027-01-21", "2026-12-23"], at("2026-12-22T10:00:00+05:30"))).toBe("2027-01-21"); // unsorted input, still the nearest that qualifies
  expect(tradingExpiry(["2026-11-20"], at("2026-11-19T10:00:00+05:30"))).toBe("2026-11-20"); // nothing else to move to
  expect(tradingExpiry([], at("2026-11-19T10:00:00+05:30"))).toBeUndefined();
});
