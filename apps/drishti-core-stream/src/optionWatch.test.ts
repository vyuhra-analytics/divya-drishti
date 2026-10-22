import { expect, test } from "bun:test";
import { LagWindow, OptionWatch, subscriptionDiff, WATCH_PER_REQUEST } from "./optionWatch";

const key = (n: number) => `MCX_FO|${100000 + n}`;
const all = () => true;

test("a valid contract is watched, repeated requests extend it and do not notify again", () => {
  let t = 0;
  const w = new OptionWatch(all, () => t, 40, 60_000);
  let changes = 0;
  w.onChange(() => changes++);
  expect(w.request([key(1), key(2)])).toEqual({ accepted: 2, refused: 0 });
  expect(w.wanted()).toEqual([key(1), key(2)]);
  expect(changes).toBe(1);
  t = 30_000;
  expect(w.request([key(1)])).toEqual({ accepted: 1, refused: 0 });
  expect(changes).toBe(1); // nothing new
  t = 61_000; // key(2) was last asked at 0, key(1) at 30 s
  expect(w.wanted()).toEqual([key(1)]);
  expect(changes).toBe(2); // key(2) expired
  t = 91_000;
  expect(w.wanted()).toEqual([]);
  expect(changes).toBe(3);
});

test("only Upstox MCX derivative keys we know are accepted; the rest is refused before it costs a subscription", () => {
  const w = new OptionWatch((k) => k === key(1), () => 0);
  expect(w.request([key(1), key(2), "NSE_FO|12345", "MCX_FO|1", "x; drop", 5, null, { a: 1 }])).toEqual({ accepted: 1, refused: 7 });
  expect(w.wanted()).toEqual([key(1)]);
  expect(w.request("not a list")).toEqual({ accepted: 0, refused: 0 });
  expect(w.request(undefined)).toEqual({ accepted: 0, refused: 0 });
});

test("with the contract list not yet loaded (every key counts as known) a malformed key is still refused by the format check", () => {
  const w = new OptionWatch(all, () => 0);
  expect(w.request(["NSE_FO|12345", "x; drop", "MCX_FO|1", `MCX_FO|${123456},MCX_FO|1`, key(5)])).toEqual({ accepted: 1, refused: 4 });
  expect(w.wanted()).toEqual([key(5)]);
});

test("one request takes at most 24 keys and the whole watch list at most 40", () => {
  const w = new OptionWatch(all, () => 0, 40, 60_000);
  const many = Array.from({ length: 60 }, (_, i) => key(i));
  expect(w.request(many)).toEqual({ accepted: WATCH_PER_REQUEST, refused: 60 - WATCH_PER_REQUEST });
  expect(w.request(many.slice(24, 48)).accepted).toBe(16); // 40 in all
  expect(w.wanted()).toHaveLength(40);
  expect(w.request([key(99)])).toEqual({ accepted: 0, refused: 1 }); // full: a new key is refused
  expect(w.request([key(0)])).toEqual({ accepted: 1, refused: 0 }); // but a key already watched is extended
});

test("subscriptionDiff says what to subscribe and unsubscribe on the open socket", () => {
  expect(subscriptionDiff(new Set([key(1), key(2)]), [key(2), key(3)])).toEqual({ sub: [key(3)], unsub: [key(1)] });
  expect(subscriptionDiff(new Set(), [])).toEqual({ sub: [], unsub: [] });
  expect(subscriptionDiff(new Set([key(1)]), [])).toEqual({ sub: [], unsub: [key(1)] });
});

test("LagWindow: nearest-rank percentiles over a bounded window, undefined lags ignored", () => {
  const l = new LagWindow(5);
  expect(l.pct(95)).toBeUndefined();
  [100, 200, 300, 400, 500].forEach((x) => l.add(x));
  l.add(undefined);
  expect(l.count).toBe(5);
  expect(l.pct(50)).toBe(300);
  expect(l.pct(95)).toBe(500);
  l.add(9000); // the window slides: 100 drops out
  expect(l.pct(0)).toBe(200);
  expect(l.pct(95)).toBe(9000);
});
