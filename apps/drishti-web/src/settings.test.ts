import { expect, test } from "bun:test";
import { formatStamp, makeFormat, validateUrl } from "./settings";

test("validateUrl allows empty, checks protocol, rejects junk", () => {
  expect(validateUrl("", ["http:", "https:"])).toBeNull();
  expect(validateUrl("http://localhost:3001", ["http:", "https:"])).toBeNull();
  expect(validateUrl("ws://localhost:3002/ws", ["ws:", "wss:"])).toBeNull();
  expect(validateUrl("http://localhost:3002/ws", ["ws:", "wss:"])).toBe("must start with ws:// or wss://");
  expect(validateUrl("localhost", ["http:"])).toBe("not a valid URL");
});

test("makeFormat respects locale grouping and decimals", () => {
  expect(makeFormat("en-IN", 2).price(1234567.891)).toBe("12,34,567.89");
  expect(makeFormat("en-US", 0).price(1234567.891)).toBe("1,234,568");
  expect(makeFormat("en-US", 2).price(undefined)).toBe("—");
});

test("formatStamp follows the 12/24-hour setting", () => {
  const t = Date.UTC(2026, 9, 20, 17, 12); // 22:42 IST
  expect(formatStamp(t, "en-IN", "12h", "datetime", "Asia/Kolkata")).toBe("20 Oct 2026, 10:42 pm IST");
  expect(formatStamp(t, "en-IN", "24h", "datetime", "Asia/Kolkata")).toBe("20 Oct 2026, 22:42 IST");
  expect(formatStamp(t, "en-US", "12h", "time", "America/New_York")).toBe("01:12 PM");
  expect(formatStamp(t, "en-IN", "24h", "date", "Asia/Kolkata")).toBe("20 Oct 2026");
});
