import { expect, test } from "bun:test";
import { intersect, labelFor, normalizeAddress, placement } from "./browserBridge";

test("a typed address becomes a web address; only http and https are ever opened", () => {
  expect(normalizeAddress("eia.gov")).toEqual({ url: "https://eia.gov/" });
  expect(normalizeAddress("  https://www.tradingview.com/chart/ ")).toEqual({ url: "https://www.tradingview.com/chart/" });
  expect(normalizeAddress("http://example.com/a?b=1")).toEqual({ url: "http://example.com/a?b=1" });
  expect(normalizeAddress("localhost:3000/x")).toEqual({ url: "http://localhost:3000/x" });
  expect(normalizeAddress("127.0.0.1:5173")).toEqual({ url: "http://127.0.0.1:5173/" });
  for (const bad of ["javascript:alert(1)", "file:///C:/Windows/win.ini", "data:text/html,<b>x</b>", "ftp://example.com", "chrome://settings", "ws://x.com"]) expect("error" in normalizeAddress(bad)).toBe(true);
  expect("error" in normalizeAddress("   ")).toBe(true);
});

test("words that are not an address are searched, not opened as a host", () => {
  const r = normalizeAddress("natural gas storage");
  expect("url" in r && r.url).toBe("https://duckduckgo.com/?q=natural%20gas%20storage");
  const single = normalizeAddress("crude");
  expect("url" in single && single.url).toContain("duckduckgo.com");
});

test("a panel's native view has a safe label of its own", () => {
  expect(labelFor("browser-1-3")).toBe("browser-browser-1-3");
  expect(labelFor("a b/c:d")).toBe("browser-a-b-c-d");
  expect(labelFor("x").startsWith("browser-")).toBe(true);
});

test("the native view covers the panel body clipped to the grid, and hides when too little is left", () => {
  const area = { x: 0, y: 40, width: 1000, height: 700 };
  expect(placement({ x: 100, y: 100, width: 400, height: 300 }, area)).toEqual({ x: 100, y: 100, width: 400, height: 300 });
  expect(placement({ x: 100, y: 20, width: 400, height: 300 }, area)).toEqual({ x: 100, y: 40, width: 400, height: 280 }); // scrolled under the top bar
  expect(placement({ x: 900, y: 100, width: 400, height: 300 }, area)).toEqual({ x: 900, y: 100, width: 100, height: 300 });
  expect(placement({ x: 100, y: 30, width: 400, height: 20 }, area)).toBeUndefined(); // only 10 px left inside the grid
  expect(placement({ x: 2000, y: 100, width: 400, height: 300 }, area)).toBeUndefined();
  expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeUndefined(); // touching is not overlapping
});
