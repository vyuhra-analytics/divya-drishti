import { expect, test } from "bun:test";
import { createRunner, SourceError, type FetchIO, type Fetcher } from "./fetcher";

/** a controllable clock and a fake network: tests never touch the internet */
function setup(env: Record<string, string> = {}) {
  let t = 1_000_000;
  const calls: string[] = [];
  const io: FetchIO = { fetch: (async () => new Response("{}")) as never, env, now: () => t };
  return { io, calls, tick: (ms: number) => (t += ms) };
}

const make = (calls: string[], behaviour: { fail?: boolean; empty?: boolean; delay?: number } = {}): Fetcher<{ id: string }, number, number[]> => ({
  id: "demo",
  label: "Demo source",
  website: "https://example.com",
  ttlMs: 1000,
  key: (q) => q.id,
  async extract(q) {
    calls.push(q.id);
    if (behaviour.delay) await new Promise((r) => setTimeout(r, behaviour.delay));
    if (behaviour.fail) throw new Error("HTTP 500");
    return calls.length;
  },
  transform: (raw) => (behaviour.empty ? [] : [raw]),
  isUsable: (r) => r.length > 0,
});

test("a fresh copy is served without calling the source; an expired one is fetched again", async () => {
  const { io, calls, tick } = setup();
  const run = createRunner(io);
  const f = make(calls);
  const a = await run(f, { id: "x" });
  expect(a.data).toEqual([1]);
  tick(500);
  expect((await run(f, { id: "x" })).data).toEqual([1]);
  expect(calls).toHaveLength(1);
  tick(600); // past the 1 s ttl
  expect((await run(f, { id: "x" })).data).toEqual([2]);
  expect(calls).toHaveLength(2);
  await run(f, { id: "y" }); // another key is its own entry
  expect(calls).toEqual(["x", "x", "y"]);
});

test("two requests for the same key at once share one fetch", async () => {
  const { io, calls } = setup();
  const run = createRunner(io);
  const f = make(calls, { delay: 20 });
  const [a, b] = await Promise.all([run(f, { id: "x" }), run(f, { id: "x" })]);
  expect(calls).toHaveLength(1);
  expect(a.data).toEqual(b.data);
});

test("when the source fails the last good copy is served as stale, with a pause before the next try", async () => {
  const { io, calls, tick } = setup();
  const run = createRunner(io);
  await run(make(calls), { id: "x" });
  tick(2000);
  const failing = make(calls, { fail: true });
  const s = await run(failing, { id: "x" });
  expect(s).toMatchObject({ data: [1], stale: true });
  expect(calls).toHaveLength(2);
  tick(60_000); // within the 5 minute pause: no new attempt
  expect((await run(failing, { id: "x" })).stale).toBe(true);
  expect(calls).toHaveLength(2);
  tick(5 * 60_000); // pause over: tries again
  await run(failing, { id: "x" });
  expect(calls).toHaveLength(3);
});

test("with no copy a failure is a SourceError; an empty result counts as a failure and never replaces a good copy", async () => {
  const { io, calls, tick } = setup();
  const run = createRunner(io);
  await expect(run(make(calls, { fail: true }), { id: "x" })).rejects.toThrow(/Demo source unavailable: HTTP 500/);
  const err = await run(make(calls, { empty: true }), { id: "z" }).catch((e) => e);
  expect(err).toBeInstanceOf(SourceError);
  expect(err.kind).toBe("unavailable");
  await run(make(calls), { id: "good" });
  tick(2000);
  expect((await run(make(calls, { empty: true }), { id: "good" })).data).toEqual([3]); // empty result: the old copy stays, stale
});

test("missing credentials give a how-to-get-a-key error without calling the source", async () => {
  const { io, calls } = setup({ OTHER: "1" });
  const run = createRunner(io);
  const keyed = { ...make(calls), credentials: ["DEMO_KEY"] as const, instructions: "free key at example.com" };
  const err = await run(keyed, { id: "x" }).catch((e) => e);
  expect(err).toBeInstanceOf(SourceError);
  expect(err.kind).toBe("credentials");
  expect(err.message).toBe("Set DEMO_KEY in .env (free key at example.com)");
  expect(calls).toHaveLength(0);
  const { io: io2, calls: c2 } = setup({ DEMO_KEY: "abc" });
  expect((await createRunner(io2)({ ...make(c2), credentials: ["DEMO_KEY"] as const }, { id: "x" })).data).toEqual([1]);
});
