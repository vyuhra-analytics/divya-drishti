import { expect, test } from "bun:test";
import { formatCanaryTable, runCanary } from "./canary";
import type { FetchIO } from "./fetcher";
import type { FixtureSample } from "./fixtureSamples";

const io = (respond: () => Response | Promise<Response>, env: Record<string, string> = {}): FetchIO => {
  let t = 0;
  return { fetch: (async () => respond()) as never, env, now: () => (t += 5) };
};
const sample = (over: Partial<FixtureSample> = {}): FixtureSample => ({
  id: "demo",
  run: async (i) => (await i.fetch("https://example.com")).text(),
  check: (txt) => (txt === "good" ? undefined : "expected the word good"),
  ...over,
});

test("a source that answers with usable data is ok", async () => {
  const r = await runCanary(sample(), io(() => new Response("good")));
  expect(r).toMatchObject({ id: "demo", status: "ok" });
  expect(r.ms).toBeGreaterThan(0);
});

test("an unreachable source is a failure, never a pass", async () => {
  const down = await runCanary(sample(), io(() => { throw new Error("ECONNREFUSED"); }));
  expect(down).toMatchObject({ status: "unreachable", detail: "ECONNREFUSED" });
  const blocked = await runCanary(sample(), io(() => new Response("nope", { status: 403 })));
  expect(blocked.status).toBe("unreachable");
  expect(blocked.detail).toMatch(/1 request\(s\) failed/);
});

test("a source that answers but no longer parses is a format failure, told apart from an outage", async () => {
  const r = await runCanary(sample(), io(() => new Response("<html>login wall</html>")));
  expect(r).toMatchObject({ status: "format", detail: "expected the word good" });
});

test("a source needing a missing key is skipped with the reason, and runs once the key is set", async () => {
  const keyed = sample({ needs: ["DEMO_KEY"] });
  expect(await runCanary(keyed, io(() => new Response("good")))).toMatchObject({ status: "skipped", detail: "set DEMO_KEY" });
  expect((await runCanary(keyed, io(() => new Response("good"), { DEMO_KEY: "x" }))).status).toBe("ok");
});

test("the start-up table has one line per source", () => {
  const t = formatCanaryTable([
    { id: "cftc-cot", status: "ok", at: 0, ms: 812 },
    { id: "jodi", status: "format", at: 0, ms: 5200, detail: "expected US refinery intake" },
  ]);
  const lines = t.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[1]).toContain("OK");
  expect(lines[2]).toContain("FORMAT");
  expect(lines[2]).toContain("expected US refinery intake");
});
