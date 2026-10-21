import { expect, test } from "bun:test";
import { applyOiBaseline, chunk, optionKey, rowPcr, type Chain } from "./options";

const chain = (): Chain => ({
  underlying: "CRUDEOIL",
  expiry: "2026-11-17",
  expiries: ["2026-11-17"],
  spot: 9286,
  updatedAt: 1,
  rows: [
    { strike: 9250, ce: { key: "a", oi: 6131, ltp: 520 }, pe: { key: "b", oi: 11212 } },
    { strike: 9300, ce: { key: "c", oi: 20951 }, pe: { key: "d", oi: 33188 } },
    { strike: 9350, ce: { key: "e" }, pe: { key: "f", oi: 11719 } }, // no call OI at all
  ],
});

test("rowPcr is put OI over call OI at the strike, undefined without call OI", () => {
  expect(rowPcr(chain().rows[0]!)).toBeCloseTo(11212 / 6131, 9);
  expect(rowPcr(chain().rows[2]!)).toBeUndefined();
  expect(rowPcr({ strike: 1 })).toBeUndefined();
});

test("OI change is measured against the previous session's closing OI when we have it", () => {
  const base = new Map([
    [optionKey("CRUDEOIL", "2026-11-17", 9250, "CE"), { prev: 5288, first: 6000 }],
    [optionKey("CRUDEOIL", "2026-11-17", 9250, "PE"), { prev: 11000 }],
    [optionKey("CRUDEOIL", "2026-11-17", 9300, "CE"), { prev: 21000 }],
  ]);
  const out = applyOiBaseline(chain(), base);
  expect(out.oiBasis).toBe("previous-close");
  expect(out.rows[0]!.ce).toMatchObject({ prevOi: 5288, oiChange: 6131 - 5288 }); // prev wins over the session's first reading
  expect(out.rows[0]!.pe).toMatchObject({ prevOi: 11000, oiChange: 212 });
  expect(out.rows[1]!.ce).toMatchObject({ oiChange: -49 });
  expect(out.rows[1]!.pe!.oiChange).toBeUndefined(); // no baseline for this leg: left alone
  expect(out.rows[2]!.ce).toEqual({ key: "e" }); // a leg without OI is untouched
});

test("without a previous session the baseline is this session's first reading, and the chain says so", () => {
  const base = new Map([[optionKey("CRUDEOIL", "2026-11-17", 9250, "CE"), { first: 6000 }]]);
  const out = applyOiBaseline(chain(), base);
  expect(out.oiBasis).toBe("session-open");
  expect(out.rows[0]!.ce).toMatchObject({ prevOi: 6000, oiChange: 131 });
  expect(applyOiBaseline(chain(), new Map()).oiBasis).toBeUndefined(); // nothing recorded yet: no change shown at all
});

test("the cached chain is not modified", () => {
  const c = chain();
  applyOiBaseline(c, new Map([[optionKey("CRUDEOIL", "2026-11-17", 9250, "CE"), { prev: 1 }]]));
  expect(c.rows[0]!.ce!.oiChange).toBeUndefined();
});

test("chunk splits a key list into batches (Upstox greeks accept 50 keys a call)", () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(chunk([], 50)).toEqual([]);
  expect(chunk(Array.from({ length: 164 }, (_, i) => i), 50).map((c) => c.length)).toEqual([50, 50, 50, 14]);
});
