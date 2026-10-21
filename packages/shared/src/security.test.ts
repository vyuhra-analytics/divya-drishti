import { expect, test } from "bun:test";
import { allowedOrigins, DEFAULT_WEB_ORIGINS, isAllowedOrigin, RateLimiter } from "./security";

test("allowedOrigins: defaults, override list, trailing slashes trimmed", () => {
  expect(allowedOrigins(undefined)).toEqual(DEFAULT_WEB_ORIGINS);
  expect(allowedOrigins("  ")).toEqual(DEFAULT_WEB_ORIGINS);
  expect(allowedOrigins("https://a.example/, http://b:8080")).toEqual(["https://a.example", "http://b:8080"]);
});

test("isAllowedOrigin: our web app and Tauri yes, foreign pages no, no Origin (curl, navigation) yes", () => {
  const allowed = allowedOrigins(undefined);
  expect(isAllowedOrigin("http://localhost:5173", allowed)).toBe(true);
  expect(isAllowedOrigin("http://tauri.localhost", allowed)).toBe(true);
  expect(isAllowedOrigin("https://evil.example", allowed)).toBe(false);
  expect(isAllowedOrigin("http://localhost:5174", allowed)).toBe(false);
  expect(isAllowedOrigin(undefined, allowed)).toBe(true);
});

test("RateLimiter: allows max per window per key, resets after the window, sweeps old keys", () => {
  const rl = new RateLimiter(2, 1000);
  expect([rl.take("a", 0), rl.take("a", 10), rl.take("a", 20)]).toEqual([true, true, false]);
  expect(rl.take("b", 20)).toBe(true); // separate key
  expect(rl.retryAfterMs("a", 500)).toBe(500);
  expect(rl.take("a", 1000)).toBe(true); // new window
  rl.take("c", 5000); // sweep removes expired a, b
  expect(rl.size).toBe(1);
});
