import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { resetStatusCache, SessionsController } from "./sessions.controller";

// GET /market/status: the exchange's own MCX status from Upstox, cached for 30 s, null when it cannot be asked. Upstox is a fake here.
const dbWith = (token: string | null) => ({ redis: { get: async (k: string) => (k === "upstox:token" ? token : null) } }) as any;
const realFetch = globalThis.fetch;
const realEnv = process.env.UPSTOX_ACCESS_TOKEN;
const realLog = console.log;
beforeEach(() => resetStatusCache());
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  if (realEnv === undefined) delete process.env.UPSTOX_ACCESS_TOKEN;
  else process.env.UPSTOX_ACCESS_TOKEN = realEnv;
});
const answering = (status: unknown, ok = true) => {
  const urls: string[] = [];
  globalThis.fetch = mock(async (url: string) => {
    urls.push(String(url));
    return { ok, status: ok ? 200 : 500, json: async () => ({ status: "success", data: { exchange: "MCX", status, last_updated: 1 } }) };
  }) as never;
  return urls;
};

test("returns the exchange status with the time it was read, and answers a repeat from the cache for 30 s", async () => {
  const urls = answering("NORMAL_OPEN");
  const c = new SessionsController(dbWith("t"));
  const before = Date.now();
  const a = await c.status();
  expect(a.mcx?.state).toBe("NORMAL_OPEN");
  expect(a.mcx!.at).toBeGreaterThanOrEqual(before);
  expect(urls).toEqual(["https://api.upstox.com/v2/market/status/MCX"]);
  const b = await c.status();
  expect(urls).toHaveLength(1);
  expect(b).toEqual(a);
});

test("without a token, or when Upstox fails or answers in another shape, the status is null and the rules decide", async () => {
  delete process.env.UPSTOX_ACCESS_TOKEN;
  globalThis.fetch = mock(async () => {
    throw new Error("must not be called without a token");
  }) as never;
  expect(await new SessionsController(dbWith(null)).status()).toEqual({ mcx: null });
  resetStatusCache();
  answering("NORMAL_OPEN", false);
  expect(await new SessionsController(dbWith("t")).status()).toEqual({ mcx: null });
  resetStatusCache();
  answering(undefined);
  expect(await new SessionsController(dbWith("t")).status()).toEqual({ mcx: null });
  resetStatusCache();
  globalThis.fetch = mock(async () => {
    throw new Error("network down");
  }) as never;
  expect(await new SessionsController(dbWith("t")).status()).toEqual({ mcx: null });
});

test("every distinct status value is logged once, and an unknown one says it is not handled", async () => {
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  answering("PRE_OPEN_START");
  const c = new SessionsController(dbWith("t"));
  expect((await c.status()).mcx?.state).toBe("PRE_OPEN_START");
  resetStatusCache(); // clears the seen values too: logged again
  answering("NORMAL_OPEN");
  await new SessionsController(dbWith("t")).status();
  expect(lines[0]).toMatch(/PRE_OPEN_START.*not handled/);
  expect(lines[1]).toMatch(/NORMAL_OPEN$/);
});
