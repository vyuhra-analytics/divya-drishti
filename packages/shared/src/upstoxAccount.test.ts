import { expect, test } from "bun:test";
import { ACCOUNT_ACCESS_HINT, classifyAccountAccess } from "./upstoxAccount";

// The real refusal Upstox gave on 2026-10-22 for funds, orders, trades, positions, profile and P&L from an unregistered IP.
const staticIp = {
  status: "error",
  errors: [{ errorCode: "UDAPI1221", message: "The API you are trying to access is permitted only when requested from the static IP configured in your account.", propertyPath: null, invalidValue: null }],
};

test("the static IP refusal is told apart from a bad token", () => {
  expect(classifyAccountAccess(401, staticIp)).toBe("static_ip");
  expect(classifyAccountAccess(403, staticIp)).toBe("static_ip");
  expect(classifyAccountAccess(401, { status: "error", errors: [{ errorCode: "UDAPI100050", message: "Invalid token used to access API" }] })).toBe("token");
  expect(classifyAccountAccess(403, { errors: [] })).toBe("token");
  expect(classifyAccountAccess(401, null)).toBe("token");
});

test("a successful answer is ok only when it looks like one, and anything else is unavailable (never read as access)", () => {
  expect(classifyAccountAccess(200, { status: "success", data: { user_id: "x" } })).toBe("ok");
  expect(classifyAccountAccess(200, { data: [] })).toBe("ok");
  expect(classifyAccountAccess(200, {})).toBe("unavailable");
  expect(classifyAccountAccess(200, null)).toBe("unavailable");
  expect(classifyAccountAccess(500, {})).toBe("unavailable");
  expect(classifyAccountAccess(429, { errors: [{ errorCode: "UDAPI10005" }] })).toBe("unavailable");
  expect(classifyAccountAccess(404, null)).toBe("unavailable");
});

test("every state has a hint, and the static IP one names the error code and what to do", () => {
  for (const s of ["ok", "static_ip", "token", "no_token", "unavailable"] as const) expect(ACCOUNT_ACCESS_HINT[s].length).toBeGreaterThan(10);
  expect(ACCOUNT_ACCESS_HINT.static_ip).toMatch(/UDAPI1221/);
  expect(ACCOUNT_ACCESS_HINT.static_ip).toMatch(/static IP/);
});
