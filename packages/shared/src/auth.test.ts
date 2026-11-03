import { expect, test } from "bun:test";
import { allowedHosts, guard, hostName, sameSecret, tokenKind, type GuardConfig } from "./auth";

const tokens = { ui: "u".repeat(32), mcp: "m".repeat(32) };
const cfg: GuardConfig = { hosts: allowedHosts(undefined), origins: ["http://localhost:5173"], tokens, publicPaths: ["/auth/upstox/callback"] };
const req = (over: Partial<Parameters<typeof guard>[0]> = {}) => guard({ method: "GET", path: "/x", host: "127.0.0.1:3001", origin: null, token: tokens.ui, ...over }, cfg);

test("host names are read without the port, and only our own names pass", () => {
  expect(hostName("Localhost:3001")).toBe("localhost");
  expect(hostName("[::1]:3001")).toBe("[::1]");
  expect(req({ host: "localhost:3001" }).ok).toBe(true);
  expect(req({ host: "[::1]:3001" }).ok).toBe(true);
  expect(req({ host: "evil.example:3001" })).toEqual({ ok: false, status: 403, message: "unknown host" }); // DNS rebinding
  expect(req({ host: undefined })).toMatchObject({ ok: false, status: 400 });
  expect(guard({ method: "GET", path: "/x", host: "api.mine.example", origin: null, token: tokens.ui }, { ...cfg, hosts: allowedHosts("api.mine.example") }).ok).toBe(true);
});

test("a foreign origin is refused even with the right token; no origin needs the token", () => {
  expect(req({ origin: "https://evil.example" })).toMatchObject({ ok: false, status: 403 });
  expect(req({ origin: "http://localhost:5173/" }).ok).toBe(true);
  expect(req({ token: undefined })).toMatchObject({ ok: false, status: 401 });
  expect(req({ token: "wrong" })).toMatchObject({ ok: false, status: 401 });
});

test("the caller kind follows the token, not anything the caller says about itself", () => {
  expect(req({ token: tokens.ui })).toEqual({ ok: true, kind: "ui" });
  expect(req({ token: tokens.mcp })).toEqual({ ok: true, kind: "mcp" });
  expect(tokenKind("", { ui: "", mcp: "" })).toBeUndefined();
  expect(tokenKind("x", { ui: "", mcp: "" })).toBeUndefined();
});

test("a preflight from an allowed origin passes without a token; the login callback is public; auth off still checks host and origin", () => {
  expect(req({ method: "OPTIONS", origin: "http://localhost:5173", token: undefined }).ok).toBe(true);
  expect(req({ method: "OPTIONS", origin: "https://evil.example", token: undefined })).toMatchObject({ ok: false, status: 403 });
  expect(req({ method: "OPTIONS", origin: null, token: undefined })).toMatchObject({ ok: false, status: 401 });
  expect(req({ path: "/auth/upstox/callback", token: undefined }).ok).toBe(true);
  const off = { ...cfg, tokens: null };
  expect(guard({ method: "POST", path: "/x", host: "localhost", origin: null, token: undefined }, off).ok).toBe(true);
  expect(guard({ method: "POST", path: "/x", host: "evil.example", origin: null, token: undefined }, off).ok).toBe(false);
});

test("secrets compare equal only when identical, whatever their length", () => {
  expect(sameSecret("abc", "abc")).toBe(true);
  expect(sameSecret("abc", "abd")).toBe(false);
  expect(sameSecret("abc", "abcd")).toBe(false);
  expect(sameSecret("", "")).toBe(true);
});
