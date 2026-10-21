import { expect, test } from "bun:test";
import { pushTrail, sparkPoints, TRAIL_MAX } from "./spark";

test("sparkPoints scales to the box, low at the bottom", () => {
  expect(sparkPoints([1, 3, 2], 10, 4)).toBe("0.0,4.0 5.0,0.0 10.0,2.0");
  expect(sparkPoints([5, 5], 10, 4)).toBe("0.0,2.0 10.0,2.0");
  expect(sparkPoints([5], 10, 4)).toBe("");
});

test("pushTrail ignores repeats and keeps the newest points", () => {
  const a = pushTrail(undefined, 1);
  expect(pushTrail(a, 1)).toBe(a);
  let t = a;
  for (let i = 2; i < TRAIL_MAX + 10; i++) t = pushTrail(t, i);
  expect(t).toHaveLength(TRAIL_MAX);
  expect(t[t.length - 1]).toBe(TRAIL_MAX + 9);
});
