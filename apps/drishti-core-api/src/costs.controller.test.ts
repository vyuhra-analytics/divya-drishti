import { afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { CostsController } from "./costs.controller";

// The route validates before it touches Redis or Upstox, answers 503 with a hint when it cannot ask Upstox, and otherwise
// returns Upstox's own calculation beside ours. Upstox is a fake here (the recorded real responses); the live check is `bun run smoke`.
const neverDb = { redis: { get: () => Promise.reject(new Error("redis must not be touched")) } } as any;
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "../../../packages/shared/fixtures/upstox-charges.json"), "utf8"));
const fut = fixture.legs.find((l: any) => l.kind === "future" && l.side === "buy");
const dbWith = (token: string | null, fronts: unknown = { CRUDEOIL: { instrument_key: fut.key, trading_symbol: "CRUDEOIL FUT 19 NOV 26" } }) =>
  ({ redis: { get: async (k: string) => (k === "upstox:token" ? token : k === "fronts" ? JSON.stringify(fronts) : null) } }) as any;

const realFetch = globalThis.fetch;
const realEnv = process.env.UPSTOX_ACCESS_TOKEN;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnv === undefined) delete process.env.UPSTOX_ACCESS_TOKEN;
  else process.env.UPSTOX_ACCESS_TOKEN = realEnv;
});

const refused = async (call: () => unknown, re: RegExp) => {
  const err = await Promise.resolve().then(call).catch((e) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  expect((err as Error).message).toMatch(re);
};

test("bad input is a 400 before Redis or Upstox are touched", async () => {
  const c = new CostsController(neverDb);
  await refused(() => c.check("MCX:CRUDEOIL", undefined, undefined, "swap", "buy", "9350"), /kind must be/);
  await refused(() => c.check("MCX:CRUDEOIL", undefined, undefined, "future", "hold", "9350"), /side must be/);
  for (const price of [undefined, "", "abc", "-5", "0", "1e9", "9350; DROP"]) await refused(() => c.check("MCX:CRUDEOIL", undefined, undefined, "future", "buy", price), /price must be/);
  for (const lots of ["0", "101", "1.5", "x"]) await refused(() => c.check("MCX:CRUDEOIL", undefined, undefined, "future", "buy", "9350", lots), /lots must be/);
  await refused(() => c.check(undefined, undefined, undefined, "future", "buy", "9350"), /either symbol/);
  await refused(() => c.check("MCX:CRUDEOIL", "MCX_FO|573422", "100", "future", "buy", "9350"), /either symbol/);
  await refused(() => c.check("DOGE", undefined, undefined, "future", "buy", "9350"), /MCX instruments/);
  await refused(() => c.check("NYMEX:CL", undefined, undefined, "future", "buy", "90"), /MCX instruments/);
  await refused(() => c.check("MCX:CRUDEOIL", undefined, undefined, "option", "buy", "500"), /needs the contract's key/);
  await refused(() => c.check(undefined, "NSE_EQ|1333", "100", "option", "buy", "500"), /key must look like/);
  await refused(() => c.check(undefined, "MCX_FO|573422&x=1", "100", "option", "buy", "500"), /key must look like/);
  for (const units of [undefined, "0", "100001", "1.5"]) await refused(() => c.check(undefined, "MCX_FO|573422", units, "option", "buy", "500"), /units/);
});

test("without a token it is a 503 that says what to do, and Upstox is never called", async () => {
  delete process.env.UPSTOX_ACCESS_TOKEN;
  globalThis.fetch = mock(async () => {
    throw new Error("must not be called");
  }) as never;
  const err = await new CostsController(dbWith(null)).check("MCX:CRUDEOIL", undefined, undefined, "future", "buy", "9350").catch((e) => e);
  expect(err).toBeInstanceOf(ServiceUnavailableException);
  expect(err.message).toMatch(/UPSTOX_ACCESS_TOKEN/);
});

test("a futures leg by symbol asks Upstox for the front month and returns both calculations", async () => {
  const urls: string[] = [];
  globalThis.fetch = mock(async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ data: { charges: fut.charges } }) };
  }) as never;
  const out = await new CostsController(dbWith("login-token")).check("MCX:CRUDEOIL", undefined, undefined, "future", "buy", String(fut.price));
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain(`instrument_token=${encodeURIComponent(fut.key)}`);
  expect(urls[0]).toContain("quantity=100");
  expect(urls[0]).toContain("transaction_type=BUY");
  expect(out.upstox.brokerage).toBe(30);
  expect(out.agree).toBe(true); // our table now matches what Upstox says for this leg
  expect(Math.abs(out.diff)).toBeLessThan(0.2);
  expect(out.key).toBe(fut.key);
});

test("an option leg by key, with units and lots; a repeat is answered from the cache", async () => {
  let calls = 0;
  const opt = fixture.legs.find((l: any) => l.kind === "option" && l.side === "sell");
  globalThis.fetch = mock(async (url: string) => {
    calls++;
    expect(String(url)).toContain("quantity=200"); // 2 lots of 100
    return { ok: true, status: 200, json: async () => ({ data: { charges: opt.charges } }) };
  }) as never;
  const c = new CostsController(dbWith("t"));
  const a = await c.check(undefined, opt.key, "100", "option", "sell", "512.5", "2");
  const b = await c.check(undefined, opt.key, "100", "option", "sell", "512.5", "2");
  expect(calls).toBe(1);
  expect(b.fetchedAt).toBe(a.fetchedAt);
  expect(a.ours.turnover).toBe(512.5 * 200);
});

test("Upstox failing, or answering in an unknown shape, is a 503 and never a made-up number", async () => {
  globalThis.fetch = mock(async () => ({ ok: false, status: 500, json: async () => ({}) })) as never;
  const err1 = await new CostsController(dbWith("t")).check(undefined, "MCX_FO|573499", "100", "option", "buy", "321").catch((e) => e);
  expect(err1).toBeInstanceOf(ServiceUnavailableException);
  expect(err1.message).toMatch(/Upstox 500/);
  globalThis.fetch = mock(async () => ({ ok: true, status: 200, json: async () => ({ data: { charges: { total: 1 } } }) })) as never;
  const err2 = await new CostsController(dbWith("t")).check(undefined, "MCX_FO|573498", "100", "option", "buy", "321").catch((e) => e);
  expect(err2).toBeInstanceOf(ServiceUnavailableException);
  expect(err2.message).toMatch(/format we do not recognise/);
});
