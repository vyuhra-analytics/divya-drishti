import { expect, test } from "bun:test";
import { isSealed, newKey, seal, unseal } from "./secretBox";

test("a value comes back as it went in, and the stored form shows none of it", async () => {
  const key = newKey();
  const value = { lines: [{ symbol: "CRUDEOIL 6350 PE", pnl: -1234.5 }], note: "family" };
  const s = await seal(value, key);
  expect(isSealed(s)).toBe(true);
  expect(JSON.stringify(s)).not.toContain("CRUDEOIL");
  expect(await unseal(s, key)).toEqual(value);
});

test("a wrong key, or a changed byte, is refused; every seal uses a new nonce", async () => {
  const key = newKey();
  const s = await seal({ a: 1 }, key);
  await expect(unseal(s, newKey())).rejects.toThrow("could not unseal");
  const flipped = { ...s, ct: (s.ct[0] === "A" ? "B" : "A") + s.ct.slice(1) };
  await expect(unseal(flipped, key)).rejects.toThrow("could not unseal");
  expect((await seal({ a: 1 }, key)).iv).not.toBe(s.iv);
  expect(isSealed({ summary: {} })).toBe(false);
});
