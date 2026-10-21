import { expect, test } from "bun:test";
import { limiter, mapLimit } from "./concurrency";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("mapLimit never runs more than the limit at once and keeps input order", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await sleep(15 - n); // later items finish sooner: order must still follow the input
    running--;
    return n * 10;
  });
  expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
  expect(peak).toBe(3);
});

test("limiter shares one gate across callers and a failure reaches only its own caller", async () => {
  const run = limiter(1);
  const order: string[] = [];
  const a = run(async () => {
    order.push("a-start");
    await sleep(10);
    order.push("a-end");
    return "a";
  });
  const b = run(async () => {
    order.push("b");
    throw new Error("boom");
  });
  const c = run(async () => {
    order.push("c");
    return "c";
  });
  expect(await a).toBe("a");
  await expect(b).rejects.toThrow("boom");
  expect(await c).toBe("c");
  expect(order).toEqual(["a-start", "a-end", "b", "c"]); // one at a time, in order, and the throw did not jam the gate
});

test("a limit below 1 still makes progress, and an empty list is fine", async () => {
  expect(await mapLimit([1, 2], 0, async (n) => n)).toEqual([1, 2]);
  expect(await mapLimit([], 3, async (n) => n)).toEqual([]);
});
