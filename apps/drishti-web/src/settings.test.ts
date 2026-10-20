import { expect, test } from "bun:test";
import { makeFormat, validateUrl } from "./settings";

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
