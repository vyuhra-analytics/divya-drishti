import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { HttpException } from "@nestjs/common";
import { PositionsController } from "./positions.controller";
import { resetAccountCache, UpstoxController } from "./upstox.controller";

// GET /auth/upstox/account tells why account reads fail without ever returning anything from the profile; the positions route says the same
// thing instead of blaming the token. Upstox is a fake here; the answers are the real shapes recorded on 2026-10-22.
const staticIp = { status: "error", errors: [{ errorCode: "UDAPI1221", message: "permitted only when requested from the static IP configured in your account." }] };
const dbWith = (token: string | null) => ({ redis: { get: async (k: string) => (k === "upstox:token" ? token : null), send: async () => -2 } }) as any;
const realFetch = globalThis.fetch;
const realEnv = process.env.UPSTOX_ACCESS_TOKEN;
beforeEach(() => resetAccountCache());
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnv === undefined) delete process.env.UPSTOX_ACCESS_TOKEN;
  else process.env.UPSTOX_ACCESS_TOKEN = realEnv;
});
const answering = (status: number, body: unknown) => {
  const urls: string[] = [];
  globalThis.fetch = mock(async (url: string) => {
    urls.push(String(url));
    return { ok: status < 300, status, json: async () => body };
  }) as never;
  return urls;
};

test("the static IP refusal is reported as static_ip with what to do, and the profile is never returned", async () => {
  const urls = answering(401, staticIp);
  const out = await new UpstoxController(dbWith("t")).account();
  expect(out.access).toBe("static_ip");
  expect(out.hint).toMatch(/UDAPI1221/);
  expect(urls).toEqual(["https://api.upstox.com/v2/user/profile"]);
  expect(Object.keys(out).sort()).toEqual(["access", "hint"]);
});

test("a readable account is ok and shows nothing from the profile; the answer is cached for a minute", async () => {
  const urls = answering(200, { status: "success", data: { user_name: "SECRET NAME", email: "secret@example.com" } });
  const c = new UpstoxController(dbWith("t"));
  const a = await c.account();
  expect(a.access).toBe("ok");
  expect(JSON.stringify(a)).not.toMatch(/SECRET|secret@/);
  await c.account();
  expect(urls).toHaveLength(1);
});

test("a rejected token, a missing token and an unreachable Upstox each have their own state", async () => {
  answering(401, { status: "error", errors: [{ errorCode: "UDAPI100050" }] });
  expect((await new UpstoxController(dbWith("t")).account()).access).toBe("token");
  resetAccountCache();
  delete process.env.UPSTOX_ACCESS_TOKEN;
  globalThis.fetch = mock(async () => {
    throw new Error("must not be called without a token");
  }) as never;
  expect((await new UpstoxController(dbWith(null)).account()).access).toBe("no_token");
  resetAccountCache();
  globalThis.fetch = mock(async () => {
    throw new Error("network down");
  }) as never;
  expect((await new UpstoxController(dbWith("t")).account()).access).toBe("unavailable");
});

test("the positions route names the static IP instead of blaming a read-only token", async () => {
  answering(401, staticIp);
  const err = await new PositionsController(dbWith("t")).positions().catch((e) => e);
  expect(err).toBeInstanceOf(HttpException);
  expect(err.message).toMatch(/static IP/);
  expect(err.message).not.toMatch(/read-only/);
  expect(err.getStatus()).toBe(401);
});
