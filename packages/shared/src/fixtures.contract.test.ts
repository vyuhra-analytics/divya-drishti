import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_SAMPLES } from "./fixtureSamples";
import { replayIO, scrubUrl, shrink, type Recorded } from "./fixtures";

// Provider contract tests: each parser runs against a REAL recorded response (`bun run fixtures:refresh` re-records them).
// A failure after a refresh means the provider changed its format; a failure without one means our parser regressed.
const dir = join(import.meta.dir, "../fixtures");
const load = (id: string): Recorded[] => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));

for (const s of FIXTURE_SAMPLES) {
  test(`${s.id}: the recorded real response parses to usable data`, async () => {
    expect(existsSync(join(dir, `${s.id}.json`))).toBe(true);
    const entries = load(s.id);
    const result = await s.run(replayIO(entries, Object.fromEntries((s.needs ?? []).map((n) => [n, "replay"]))));
    expect(s.check(result)).toBeUndefined();
  });
}

test("fixtures contain no credentials", () => {
  for (const s of FIXTURE_SAMPLES) {
    for (const e of load(s.id)) expect(e.url).not.toMatch(/api_key=|apikey=|access_token=|token=/i);
  }
});

test("scrubUrl removes credential parameters and keeps the rest", () => {
  expect(scrubUrl("https://api.eia.gov/v2/seriesid/PET.WCESTUS1.W?api_key=SECRET&length=60")).toBe("https://api.eia.gov/v2/seriesid/PET.WCESTUS1.W?length=60");
});

test("replay refuses a request it never recorded instead of going to the network", async () => {
  const io = replayIO([{ method: "GET", url: "https://example.com/a", status: 200, contentType: "text/plain", text: "a", recordedAt: "2026-10-21T00:00:00Z" }]);
  expect(await (await io.fetch("https://example.com/a")).text()).toBe("a");
  await expect(io.fetch("https://example.com/b")).rejects.toThrow(/no recorded response for GET https:\/\/example.com\/b/);
  expect(io.now()).toBe(Date.parse("2026-10-21T00:00:00Z"));
});

test("shrink cuts JSON lists and filters CSV lines, keeping the header", () => {
  const base = { method: "GET", url: "u", status: 200, contentType: "", recordedAt: "x" };
  expect(JSON.parse(shrink({ ...base, text: JSON.stringify([1, 2, 3, 4]) }, { maxItems: 2 }).text)).toEqual([1, 2]);
  expect(JSON.parse(shrink({ ...base, text: JSON.stringify({ features: [1, 2, 3], other: "kept" }) }, { maxItems: 2 }).text)).toEqual({ features: [1, 2], other: "kept" });
  expect(shrink({ ...base, text: "h,h\nIN,1\nFR,2\nIN,3" }, { keepLine: (l) => l.startsWith("IN") }).text).toBe("h,h\nIN,1\nIN,3");
});
