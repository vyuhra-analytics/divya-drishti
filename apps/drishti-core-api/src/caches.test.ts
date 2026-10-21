import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Every cache in the API can be reached with caller-chosen keys (a symbol, an expiry, a ticker...), so each must have a size cap.
// Validation already bounds the keys today; this keeps it that way when someone adds the next cache: use LruCache, not a bare Map.
test("no module-level cache in the API is an unbounded Map", () => {
  const offenders: string[] = [];
  for (const f of readdirSync(import.meta.dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
    readFileSync(join(import.meta.dir, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/^(const|let)\s+\w*cache\w*\s*(:[^=]+)?=\s*new Map\b/i.test(line.trim())) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  expect(offenders).toEqual([]);
});
