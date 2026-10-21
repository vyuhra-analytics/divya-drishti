import { expect, test } from "bun:test";
import { LruCache } from "./lru";

test("the least recently used entry goes when the cap is exceeded", () => {
  const c = new LruCache<number>(3);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.set("d", 4); // a is oldest
  expect(c.get("a")).toBeUndefined();
  expect([c.get("b"), c.get("c"), c.get("d")]).toEqual([2, 3, 4]);
  expect(c.size).toBe(3);
});

test("reading an entry keeps it; writing an existing key refreshes it without growing the cache", () => {
  const c = new LruCache<number>(3);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.get("a"); // a is now the most recent, so b is next to go
  c.set("d", 4);
  expect(c.get("b")).toBeUndefined();
  expect(c.get("a")).toBe(1);
  c.set("a", 10);
  expect(c.size).toBe(3);
  expect(c.get("a")).toBe(10);
});

test("a flood of distinct keys cannot grow it past the cap", () => {
  const c = new LruCache<number>(50);
  for (let i = 0; i < 10_000; i++) c.set(`k${i}`, i);
  expect(c.size).toBe(50);
  expect(c.get("k9999")).toBe(9999);
  expect(c.get("k0")).toBeUndefined();
});
