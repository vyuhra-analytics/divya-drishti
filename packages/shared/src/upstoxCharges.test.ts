import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareCosts, parseUpstoxCharges, upstoxChargesUrl } from "./upstoxCharges";
import { legCosts, UPSTOX_MCX_RATES, type Kind, type Side } from "./costs";

// Upstox's own charge calculation, recorded on 2026-10-22 for six legs of one crude lot (`bun run fixtures:upstox-charges` re-records it).
// Our cost table must agree with it leg by leg: the table is checked against Upstox, not the other way round.
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/upstox-charges.json"), "utf8")) as {
  legs: { kind: Kind; side: Side; price: number; units: number; key: string; charges: unknown }[];
};

test("the fixture holds six legs and no credentials", () => {
  expect(fixture.legs).toHaveLength(6);
  expect(JSON.stringify(fixture)).not.toMatch(/bearer|access_token|authorization/i);
});

test("every recorded leg parses and our table agrees with Upstox within Rs 0.15 in total and 5 paise per line", () => {
  for (const l of fixture.legs) {
    const up = parseUpstoxCharges({ data: { charges: l.charges } });
    expect(up).toBeDefined();
    const ours = legCosts(l.kind, l.side, l.price, l.units, 1, UPSTOX_MCX_RATES);
    const label = `${l.kind} ${l.side} @ ${l.price}`;
    expect([label, Math.abs(ours.total - up!.total) <= 0.15]).toEqual([label, true]);
    for (const k of ["brokerage", "gst", "ctt", "exchange", "sebi", "stamp"] as const) {
      expect([label, k, Math.abs(ours[k] - up![k]) <= 0.05]).toEqual([label, k, true]);
    }
    expect(compareCosts(up!, ours).agree).toBe(true);
  }
});

test("the table at Rs 20 brokerage would have been caught: it is Rs 10 short per order", () => {
  const l = fixture.legs[0];
  const up = parseUpstoxCharges({ data: { charges: l.charges } })!;
  const old = legCosts(l.kind, l.side, l.price, l.units, 1, { ...UPSTOX_MCX_RATES, brokerageFlat: 20 });
  const check = compareCosts(up, old);
  expect(check.agree).toBe(false);
  expect(check.diff).toBeCloseTo(-11.8, 1); // Rs 10 brokerage plus 18% GST on it
});

test("parseUpstoxCharges refuses a response with a missing figure instead of reading it as zero", () => {
  const l = fixture.legs[0];
  const broken: any = JSON.parse(JSON.stringify({ data: { charges: l.charges } }));
  delete broken.data.charges.taxes.gst;
  expect(parseUpstoxCharges(broken)).toBeUndefined();
  expect(parseUpstoxCharges({})).toBeUndefined();
  expect(parseUpstoxCharges({ data: { charges: "x" } })).toBeUndefined();
});

test("the request is built for one order, with the instrument key escaped", () => {
  const url = upstoxChargesUrl("MCX_FO|573422", 100, 9350, "sell");
  expect(url).toBe("https://api.upstox.com/v2/charges/brokerage?instrument_token=MCX_FO%7C573422&quantity=100&product=I&transaction_type=SELL&price=9350");
});
