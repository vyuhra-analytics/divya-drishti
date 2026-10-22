import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The archive upsert is SQL that no unit test can run, so this guards the one property the sentiment study depends on:
// first_seen_at is written when a story is inserted and is NEVER overwritten by a later poll.
const src = readFileSync(join(import.meta.dir, "news.ts"), "utf8");
const upsert = src.slice(src.indexOf("INSERT INTO news"), src.indexOf("`;", src.indexOf("INSERT INTO news")));
const [insertPart, conflictPart] = upsert.split("ON CONFLICT (id) DO UPDATE SET");

test("the archive sets first_seen_at on insert", () => {
  expect(insertPart).toContain("first_seen_at");
  expect(insertPart).toMatch(/now\(\), now\(\)/); // updated_at and first_seen_at both start at the insert time
});

test("the archive never overwrites first_seen_at when a later poll touches the story", () => {
  expect(conflictPart).toBeDefined();
  const assignments = conflictPart!.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"); // comments may name it, assignments must not
  expect(assignments).not.toMatch(/first_seen_at\s*=/);
  expect(assignments).toContain("updated_at = now()"); // while updated_at does move, which is why it cannot be used as the first-seen time
});

test("the migration adds a nullable column and does not invent a time for older rows", () => {
  const sql = readFileSync(join(import.meta.dir, "../../../infra/sql/011_news_first_seen.sql"), "utf8");
  expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;/);
  expect(sql).not.toMatch(/UPDATE news/i); // no backfill from updated_at: a guessed first-seen time would contaminate the study
  expect(sql).not.toMatch(/first_seen_at TIMESTAMPTZ\s+NOT NULL/i);
});
