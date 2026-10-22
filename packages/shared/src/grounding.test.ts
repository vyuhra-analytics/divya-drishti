import { expect, test } from "bun:test";
import { buildContext, type BriefingContext, type BriefingResult, type ContextInput } from "./briefing";
import { checkBriefing, citableFields, groundingFeedback, writeGrounded, type Cite } from "./grounding";
import type { Bar, Quote } from "./index";

const T0 = 1_760_000_000;
const bars: Bar[] = Array.from({ length: 80 }, (_, i) => {
  const close = 9000 + i * 2 + (i % 3);
  return { time: T0 + i * 300, open: close - 1, high: close + 2, low: close - 2, close, volume: 100 };
});
const quote: Quote = { symbol: "MCX:CRUDEOIL", price: 9158, time: T0 * 1000, prevClose: 9000, open: 9010, high: 9170, low: 8990, oi: 14600, source: "upstox", delayedBy: 0 };
const now = T0 * 1000;
const input = (over: Partial<ContextInput> = {}): ContextInput => ({
  symbol: "MCX:CRUDEOIL",
  quote,
  bars,
  timeframe: "5m",
  news: [
    { id: "a", title: "Brent climbs as OPEC+ signals deeper cuts", url: "u", source: "Reuters", publishedAt: now - 10 * 60_000, tags: ["crude"] },
    { id: "b", title: "US crude stocks fall for a third week", url: "u", source: "EIA", publishedAt: now - 50 * 60_000, tags: ["crude"] },
  ],
  events: [{ id: "e", title: "EIA crude inventories", at: now + 90 * 60_000, kind: "energy", impact: "high" }],
  now,
  ...over,
});
const ctx: BriefingContext = buildContext(input());
const f = citableFields(ctx);

const point = (p: string, ...cites: Cite[]) => ({ point: p, evidence: cites.map((c) => `${c.field} ${c.value}`).join(", "), cites });
const result = (over: Partial<BriefingResult> = {}): BriefingResult => ({
  bias: "bullish",
  confidence: "medium",
  summary: "Price is above its short average.",
  bull: [point("Momentum is strong", { field: "technicals.rsi14", value: String(f["technicals.rsi14"]) })],
  bear: [point("Far above the day open", { field: "price", value: "9158" })],
  watch: ["EIA release soon"],
  data_gaps: [],
  ...over,
});

test("citableFields lists the numbers, the headlines and the events by path", () => {
  expect(f.price).toBe(9158);
  expect(f["day.high"]).toBe(9170);
  expect(typeof f["technicals.rsi14"]).toBe("number");
  expect(f["news.1"]).toBe("Brent climbs as OPEC+ signals deeper cuts");
  expect(f["news.2.ageMin"]).toBe(50);
  expect(f["events.1"]).toBe("EIA crude inventories");
  expect(f["events.1.inMin"]).toBe(90);
  expect(f["provenance.price.quality"]).toBe("live");
  expect(f["provenance.price.asOf"]).toBeUndefined(); // timestamps are not facts to argue from
  expect(f.asOf).toBeUndefined();
});

test("a correct citation is verified", () => {
  const r = checkBriefing(result(), ctx);
  expect(r).toMatchObject({ verified: 2, total: 2, wrong: 0, other: [] });
  expect(r.points.every((p) => p.verdict === "verified")).toBe(true);
});

test("a cited value that contradicts the data is wrong, and says what the data holds", () => {
  const r = checkBriefing(result({ bull: [point("Overbought", { field: "technicals.rsi14", value: "30" })] }), ctx);
  expect(r.wrong).toBe(1);
  expect(r.points[0]).toMatchObject({ section: "bull", verdict: "wrong" });
  expect(r.points[0]!.issues[0]!.text).toContain(`technicals.rsi14 is ${f["technicals.rsi14"]}, not 30`);
});

test("a field that does not exist is wrong", () => {
  const r = checkBriefing(result({ bear: [point("Weak", { field: "technicals.stochastic", value: "12" })] }), ctx);
  expect(r.points[1]).toMatchObject({ verdict: "wrong" });
  expect(r.points[1]!.issues[0]!.text).toContain("not a field");
});

test("rounding is tolerated, a real difference is not", () => {
  const close = checkBriefing(result({ bear: [point("p", { field: "price", value: "9,158.4" })] }), ctx);
  expect(close.wrong).toBe(0);
  const far = checkBriefing(result({ bear: [point("p", { field: "price", value: "9300" })] }), ctx);
  expect(far.wrong).toBe(1);
  const signed = checkBriefing(result({ bear: [point("p", { field: "changePct", value: "+1.76%" })] }), ctx);
  expect(signed.wrong).toBe(0);
});

test("a headline may be quoted in part, but not replaced by another", () => {
  expect(checkBriefing(result({ bull: [point("Supply news", { field: "news.1", value: "Brent climbs as OPEC+ signals" })] }), ctx).wrong).toBe(0);
  expect(checkBriefing(result({ bull: [point("Supply news", { field: "news.1", value: "Saudi Arabia raises output" })] }), ctx).wrong).toBe(1);
  expect(checkBriefing(result({ bull: [point("Supply news", { field: "news.9", value: "Brent climbs" })] }), ctx).wrong).toBe(1); // no 9th headline
});

test("a point with no citation cannot be checked, but is not called wrong", () => {
  const r = checkBriefing(result({ bull: [{ point: "Sentiment is positive", evidence: "general mood" }] }), ctx);
  expect(r.points[0]).toMatchObject({ verdict: "unverified" });
  expect(r.wrong).toBe(0);
});

test("a figure in the prose that is not in the data is flagged; figures from the data, small counts and years are not", () => {
  const loose = checkBriefing(result({ bull: [point("Target near 9420 is likely", { field: "price", value: "9158" })] }), ctx);
  expect(loose.points[0]).toMatchObject({ verdict: "unverified" });
  expect(loose.points[0]!.issues[0]).toEqual({ kind: "loose", text: "9420 is not in the data." });
  const fine = checkBriefing(result({ bull: [point("Up 1.76% to 9,158, above the 14-period average in 2026", { field: "price", value: "9158" })] }), ctx);
  expect(fine.points[0]!.verdict).toBe("verified");
  const summary = checkBriefing(result({ summary: "Could reach 9500 soon." }), ctx);
  expect(summary.other).toEqual([{ kind: "loose", text: "9500 is not in the data." }]);
});

test("calling a delayed or closed price live is flagged; saying it is closed is not", () => {
  const closed = buildContext(input({ freshness: "closed" }));
  expect(checkBriefing(result({ summary: "Live price is climbing." }), closed).other[0]!.text).toContain("closed");
  expect(checkBriefing(result({ summary: "The market is closed, so this is the last price." }), closed).other).toEqual([]);
  expect(checkBriefing(result({ summary: "Live price is climbing." }), ctx).other).toEqual([]); // genuinely live
});

test("the feedback names each wrong cite with the true value", () => {
  const r = checkBriefing(result({ bull: [point("p", { field: "technicals.rsi14", value: "30" })], bear: [point("q", { field: "day.high", value: "9999" })] }), ctx);
  const text = groundingFeedback(r);
  expect(text).toContain("bull point 1: technicals.rsi14 is");
  expect(text).toContain("bear point 1: day.high is 9170, not 9999");
});

const good = result();
const bad = result({ bull: [point("Overbought", { field: "technicals.rsi14", value: "30" })] });
const worse = result({ bull: [point("a", { field: "technicals.rsi14", value: "30" })], bear: [point("b", { field: "price", value: "1" })] });

test("writeGrounded: a clean first answer costs one call", async () => {
  const feedbacks: (string | undefined)[] = [];
  const g = await writeGrounded(ctx, async (fb) => (feedbacks.push(fb), good));
  expect(g.attempts).toBe(1);
  expect(feedbacks).toEqual([undefined]);
  expect(g.report.wrong).toBe(0);
});

test("writeGrounded: a wrong cite triggers one retry carrying exactly what was wrong, and the corrected answer wins", async () => {
  const feedbacks: (string | undefined)[] = [];
  let n = 0;
  const g = await writeGrounded(ctx, async (fb) => (feedbacks.push(fb), n++ === 0 ? bad : good));
  expect(g.attempts).toBe(2);
  expect(feedbacks[0]).toBeUndefined();
  expect(feedbacks[1]).toContain("technicals.rsi14 is");
  expect(g.result).toBe(good);
  expect(g.report.wrong).toBe(0);
});

test("writeGrounded: a retry that is worse is discarded, and a failing retry keeps the first answer; never more than two calls", async () => {
  let calls = 0;
  const g1 = await writeGrounded(ctx, async () => (calls++, calls === 1 ? bad : worse));
  expect(g1.result).toBe(bad);
  expect(calls).toBe(2);
  const g2 = await writeGrounded(ctx, async () => {
    if (calls++ > 2) throw new Error("rate limited");
    return bad;
  });
  expect(g2.result).toBe(bad);
  expect(g2.attempts).toBe(1);
  let always = 0;
  await writeGrounded(ctx, async () => (always++, bad));
  expect(always).toBe(2);
});
