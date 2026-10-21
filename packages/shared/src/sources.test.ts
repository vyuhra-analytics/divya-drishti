import { expect, test } from "bun:test";
import { canaryInterval, CANARY_SPACING, FIXTURE_SAMPLES, SOURCES, sourceInfo } from "./index";

test("every source has a risk, a fallback rule and a reason", () => {
  for (const s of SOURCES) {
    expect(["low", "medium", "high"]).toContain(s.risk);
    expect(["auto", "explicit"]).toContain(s.fallback);
    expect(s.note.length).toBeGreaterThan(10);
  }
  expect(new Set(SOURCES.map((s) => s.id)).size).toBe(SOURCES.length);
});

test("sources that would mislead or cost money are explicit-only; the rest may fall back on their own", () => {
  expect(sourceInfo("tradingview-mcx-continuous")?.fallback).toBe("explicit"); // wrong contract near expiry
  expect(sourceInfo("anthropic")?.fallback).toBe("explicit"); // costs money
  expect(SOURCES.filter((s) => s.fallback === "explicit").map((s) => s.id).sort()).toEqual(["anthropic", "tradingview-mcx-continuous"]);
  expect(sourceInfo("forex-factory")?.risk).toBe("high"); // already answers 429
  expect(sourceInfo("cftc-cot")?.risk).toBe("low");
});

test("every canary sample points at a registered source, and riskier sources are probed less often", () => {
  for (const s of FIXTURE_SAMPLES) expect(sourceInfo(s.source)).toBeDefined();
  const hour = 3600_000;
  expect(canaryInterval("cftc-cot", hour)).toBe(hour); // low
  expect(canaryInterval("yahoo", hour)).toBe(2 * hour); // medium
  expect(canaryInterval("forex-factory", hour)).toBe(6 * hour); // high
  expect(canaryInterval("unknown-source", hour)).toBe(hour * CANARY_SPACING.medium); // unknown counts as medium
});
