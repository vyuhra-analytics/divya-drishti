import { expect, test } from "bun:test";
import { BadGatewayException } from "@nestjs/common";
import { buildContext, citableFields, type Bar, type BriefingContext, type Quote } from "@drishti/shared";
import { BriefingController, type Complete } from "./briefing.controller";

// The model is faked: these tests cover what the API does with its answers (check them against the data, retry once, refuse cleanly).
// Each test uses its own symbol because the controller caches per symbol.
const T0 = 1_760_000_000;
const bars: Bar[] = Array.from({ length: 80 }, (_, i) => ({ time: T0 + i * 300, open: 9000 + i * 2, high: 9003 + i * 2, low: 8998 + i * 2, close: 9001 + i * 2, volume: 10 }));
const ctxFor = (symbol: string): BriefingContext => {
  const quote: Quote = { symbol, price: 9158, time: T0 * 1000, prevClose: 9000, source: "upstox", delayedBy: 0 };
  return buildContext({ symbol, quote, bars, timeframe: "5m", news: [], events: [], now: T0 * 1000 });
};
const answer = (rsi: string) => ({
  bias: "bullish" as const,
  confidence: "medium" as const,
  summary: "Price is above its average.",
  bull: [{ point: "Momentum", evidence: `rsi14 ${rsi}`, cites: [{ field: "technicals.rsi14", value: rsi }] }],
  bear: [{ point: "Stretched", evidence: "price 9158", cites: [{ field: "price", value: "9158" }] }],
  watch: [],
  data_gaps: [],
});
const usage = { input: 1000, output: 200 };
const controllerWith = (complete: Complete) => Object.assign(new BriefingController(), { complete });

test("a briefing whose citations match the data costs one call and comes back verified", async () => {
  const ctx = ctxFor("MCX:CRUDEOIL");
  const rsi = String(citableFields(ctx)["technicals.rsi14"]);
  let calls = 0;
  const res = await controllerWith(async () => (calls++, { out: answer(rsi), model: "m", usage, refused: false })).brief({ context: ctx });
  expect(calls).toBe(1);
  expect(res.attempts).toBe(1);
  expect(res.grounding).toMatchObject({ verified: 2, total: 2, wrong: 0 });
  expect(res.usage).toEqual(usage);
});

test("a wrong citation is sent back once with what was wrong and the earlier answer; the corrected answer is returned and usage is summed", async () => {
  const ctx = ctxFor("MCX:CRUDEOILM");
  const rsi = String(citableFields(ctx)["technicals.rsi14"]);
  const seen: unknown[][] = [];
  const res = await controllerWith(async (messages) => {
    seen.push(messages);
    return { out: answer(seen.length === 1 ? "12" : rsi), model: "m", usage, refused: false };
  }).brief({ context: ctx });
  expect(res.attempts).toBe(2);
  expect(seen[0]).toHaveLength(1);
  expect(seen[1]).toHaveLength(3); // the question, its own earlier answer, and the correction
  expect(JSON.stringify(seen[1]![2])).toContain("technicals.rsi14 is");
  expect(res.grounding.wrong).toBe(0);
  expect(res.result.bull[0]!.cites![0]!.value).toBe(rsi);
  expect(res.usage).toEqual({ input: 2000, output: 400 });
});

test("if the retry is still wrong the points are kept and marked wrong, not hidden", async () => {
  const ctx = ctxFor("MCX:NATURALGAS");
  const res = await controllerWith(async () => ({ out: answer("12"), model: "m", usage, refused: false })).brief({ context: ctx });
  expect(res.attempts).toBe(2);
  expect(res.grounding.wrong).toBe(1);
  expect(res.result.bull).toHaveLength(1);
});

test("a refusal is a clear 502 that points to the no-AI recap", async () => {
  const c = controllerWith(async () => ({ out: null, model: "m", usage, refused: true }));
  const err = await c.brief({ context: ctxFor("MCX:NATGASMINI") }).catch((e) => e);
  expect(err).toBeInstanceOf(BadGatewayException);
  expect(err.message).toContain("Recap");
});

test("an unreadable answer is a 502", async () => {
  const c = controllerWith(async () => ({ out: null, model: "m", usage, refused: false }));
  const err = await c.brief({ context: ctxFor("NYMEX:CL") }).catch((e) => e);
  expect(err).toBeInstanceOf(BadGatewayException);
});

test("the second answer is cached: asking again does not call the model", async () => {
  const ctx = ctxFor("NYMEX:NG");
  const rsi = String(citableFields(ctx)["technicals.rsi14"]);
  let calls = 0;
  const c = controllerWith(async () => (calls++, { out: answer(rsi), model: "m", usage, refused: false }));
  await c.brief({ context: ctx });
  const again = await c.brief({ context: ctx });
  expect(calls).toBe(1);
  expect(again.cached).toBe(true);
  expect(again.grounding.verified).toBe(2);
});

test("a context for an unknown symbol is refused before any model call", async () => {
  let calls = 0;
  const c = controllerWith(async () => (calls++, { out: null, model: "m", usage, refused: false }));
  await expect(c.brief({ context: { ...ctxFor("MCX:CRUDEOIL"), symbol: "MCX:GOLD" } })).rejects.toThrow(/one of our instruments/);
  expect(calls).toBe(0);
});
