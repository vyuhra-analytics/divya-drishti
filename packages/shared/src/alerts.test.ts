import { expect, test } from "bun:test";
import { check, crossed, describe, type Alert, type AlertWorld } from "./alerts";

const world = (over: Partial<AlertWorld> = {}): AlertWorld => ({ quotes: {}, freshNews: [], events: [], now: 1_000_000, ...over });
const price = (over: Partial<Alert> = {}): Alert => ({ id: "a", kind: "price", symbol: "MCX:CRUDEOIL", op: "above", value: 9500, armed: true, ...over });

test("crossed needs a change of side, not just being past the level", () => {
  expect(crossed("above", 100, 99, 101)).toBe(true);
  expect(crossed("above", 100, 100.5, 101)).toBe(false);
  expect(crossed("above", 100, 99, 100)).toBe(true); // touching counts
  expect(crossed("below", 100, 101, 99)).toBe(true);
  expect(crossed("below", 100, 99, 98)).toBe(false);
});

test("price alert: first look only records, then fires once on the cross", () => {
  let a = price();
  let r = check(a, world({ quotes: { "MCX:CRUDEOIL": { price: 9400 } } }));
  expect(r.message).toBeUndefined();
  expect(r.next.last).toBe(9400);
  r = check(r.next, world({ quotes: { "MCX:CRUDEOIL": { price: 9510 } } }));
  expect(r.message).toContain("9510");
  expect(r.next).toMatchObject({ armed: false, firedAt: 1_000_000 });
  r = check(r.next, world({ quotes: { "MCX:CRUDEOIL": { price: 9600 } } })); // spent: stays quiet
  expect(r.message).toBeUndefined();
  expect(check(a, world()).next).toBe(a); // no quote yet: untouched
});

test("change alert uses % vs previous close, below for falls", () => {
  const a: Alert = { id: "c", kind: "change", symbol: "NYMEX:CL", op: "below", value: -2, armed: true };
  let r = check(a, world({ quotes: { "NYMEX:CL": { price: 99, prevClose: 100 } } }));
  r = check(r.next, world({ quotes: { "NYMEX:CL": { price: 97.5, prevClose: 100 } } }));
  expect(r.message).toBe("NYMEX:CL: -2.50% (below -2%)");
  expect(describe(a)).toBe("NYMEX:CL down 2% or more on the day");
});

test("news alert fires on a matching new headline and keeps watching", () => {
  const a: Alert = { id: "n", kind: "news", text: "opec", armed: true };
  const item = (title: string) => ({ id: title, title, url: "u", source: "Reuters", publishedAt: 1, tags: [] });
  expect(check(a, world({ freshNews: [item("Gold rises")] })).message).toBeUndefined();
  const r = check(a, world({ freshNews: [item("OPEC+ agrees cut")] }));
  expect(r.message).toBe("Reuters: OPEC+ agrees cut");
  expect(r.next.armed).toBe(true);
});

test("release alert fires once per event inside the lead window", () => {
  const a: Alert = { id: "r", kind: "release", text: "eia crude", minutes: 15, armed: true };
  const ev = { id: "eia-1", title: "EIA crude inventories", at: 1_000_000 + 10 * 60_000, kind: "energy" as const, impact: "high" as const };
  expect(check(a, world({ events: [{ ...ev, at: 1_000_000 + 30 * 60_000 }] })).message).toBeUndefined(); // too early
  const r = check(a, world({ events: [ev] }));
  expect(r.message).toBe("EIA crude inventories in 10 min");
  expect(check(r.next, world({ events: [ev] })).message).toBeUndefined(); // already announced
  expect(check(a, world({ events: [{ ...ev, at: 1_000_000 - 1 }] })).message).toBeUndefined(); // already happened
});
