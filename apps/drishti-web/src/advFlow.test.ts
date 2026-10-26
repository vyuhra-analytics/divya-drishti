import { afterEach, expect, mock, test } from "bun:test";
import type { FlowBucket } from "@drishti/shared";
import { BOOK_ID, bookPoints, DELTA_ID, deltaPoints, flowStudies, loadFlow, registerFlowStudies } from "./advFlow";

const bucket = (time: number, delta: number, imbalance?: number): FlowBucket => ({ time, buy: Math.max(delta, 0), sell: Math.max(-delta, 0), unclassified: 0, volume: Math.abs(delta), delta, cumDelta: 0, imbalance, msgs: 100 });

afterEach(() => {
  globalThis.fetch = fetch;
});

test("delta is drawn as two histograms, buy bars above zero and sell bars below, so each can have its own colour", () => {
  expect(deltaPoints([bucket(100, 6), bucket(160, -4), bucket(220, 0)])).toEqual([
    { time: 100, values: { up: 6, down: 0 } },
    { time: 160, values: { up: 0, down: -4 } },
    { time: 220, values: { up: 0, down: 0 } },
  ]);
});

test("the book study leaves out candles with no book instead of drawing them as zero", () => {
  expect(bookPoints([bucket(100, 1, 0.25), bucket(160, 1, undefined), bucket(220, 1, -0.5)])).toEqual([
    { time: 100, values: { book: 0.25 } },
    { time: 220, values: { book: -0.5 } },
  ]);
});

test("loadFlow asks the route for the chart's own interval, never more than two days, and the end of the last candle", async () => {
  const urls: string[] = [];
  globalThis.fetch = mock(async (u: string) => {
    urls.push(String(u));
    return { ok: true, status: 200, json: async () => ({ buckets: [bucket(1, 2)] }) };
  }) as never;
  const to = 1_800_000_000;
  const out = await loadFlow("MCX:CRUDEOIL", "5m", to - 10 * 86_400, to);
  expect(out).toHaveLength(1);
  const q = new URL(urls[0], "http://x").searchParams;
  expect(q.get("key")).toBe("MCX:CRUDEOIL");
  expect(q.get("tf")).toBe("5m");
  expect(Number(q.get("to"))).toBe((to + 300) * 1000);
  expect(Number(q.get("to")) - Number(q.get("from"))).toBeLessThanOrEqual(47 * 3600 * 1000); // the route allows two days
});

test("loadFlow makes no request for what the route cannot serve: other exchanges, daily candles, a missing symbol", async () => {
  const f = mock(async () => ({ ok: true, status: 200, json: async () => ({ buckets: [bucket(1, 2)] }) }));
  globalThis.fetch = f as never;
  expect(await loadFlow("NYMEX:CL", "5m", 0, 100)).toEqual([]);
  expect(await loadFlow("MCX:CRUDEOIL", "1D", 0, 100)).toEqual([]);
  expect(await loadFlow(undefined, "5m", 0, 100)).toEqual([]);
  expect(await loadFlow("MCX:CRUDEOIL", "5m", 0, 0)).toEqual([]);
  expect(f).not.toHaveBeenCalled();
});

test("a route error gives no points rather than an error on the chart", async () => {
  globalThis.fetch = mock(async () => ({ ok: false, status: 503, json: async () => ({}) })) as never;
  expect(await loadFlow("MCX:CRUDEOIL", "5m", 0, 100)).toEqual([]);
});

test("the studies are titled as estimates, sit in their own pane and decline what they cannot show", () => {
  const [delta, book] = flowStudies();
  expect(delta.id).toBe(DELTA_ID);
  expect(book.id).toBe(BOOK_ID);
  expect(`${delta.name} ${book.name}`).toContain("(estimated)");
  expect(delta.placement).toBe("pane");
  const ok = { settings: {}, bars: [], from: 0, to: 0, dataContext: { symbol: "MCX:CRUDEOIL", interval: "5m" } };
  expect(delta.supports?.(ok as never)).toBe(true);
  expect(delta.supports?.({ ...ok, dataContext: { symbol: "NYMEX:CL", interval: "5m" } } as never)).toBe(false);
  expect(delta.supports?.({ ...ok, dataContext: { symbol: "MCX:CRUDEOIL", interval: "1D" } } as never)).toBe(false);
});

test("registering is done once per study and a failing library call never throws into the chart", () => {
  const have = new Set<string>();
  const registered: string[] = [];
  const register = (d: { id: string }) => void (registered.push(d.id), have.add(d.id));
  const create = (d: { id: string }) => d as never;
  registerFlowStudies(register as never, create as never, (id) => have.has(id));
  registerFlowStudies(register as never, create as never, (id) => have.has(id)); // a second chart on the page
  expect(registered).toEqual([DELTA_ID, BOOK_ID]);
  const warn = mock(() => undefined);
  const real = console.warn;
  console.warn = warn as never;
  expect(() =>
    registerFlowStudies(
      () => {
        throw new Error("boom");
      },
      create as never,
      () => false,
    ),
  ).not.toThrow();
  console.warn = real;
  expect(warn).toHaveBeenCalled();
});
