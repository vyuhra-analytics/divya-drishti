import { expect, test } from "bun:test";
import { parseSubmission } from "./briefingSubmit";

const point = (p = "Momentum is up") => ({ point: p, evidence: "rsi14 71", cites: [{ field: "technicals.rsi14", value: "71" }] });
const body = (over: Record<string, unknown> = {}) => ({
  symbol: "MCX:CRUDEOIL",
  context_id: "ctx-abc",
  bias: "bullish",
  confidence: "medium",
  summary: "Crude is firm.",
  bull: [point()],
  bear: [point("Stretched")],
  watch: ["EIA at 20:00 IST"],
  data_gaps: [],
  ...over,
});
const err = (b: unknown) => {
  const r = parseSubmission(b);
  if ("submission" in r) throw new Error("accepted");
  return r.error;
};

test("a well-formed submission becomes a briefing result with its cites", () => {
  const r = parseSubmission(body());
  if ("error" in r) throw new Error(r.error);
  expect(r.submission).toMatchObject({ symbol: "MCX:CRUDEOIL", contextId: "ctx-abc" });
  expect(r.submission.result.bull[0]).toEqual({ point: "Momentum is up", evidence: "rsi14 71", cites: [{ field: "technicals.rsi14", value: "71" }] });
  expect(r.submission.result.watch).toEqual(["EIA at 20:00 IST"]);
});

test("missing or wrong top-level fields are refused with the reason", () => {
  expect(err(null)).toMatch(/symbol/);
  expect(err(body({ context_id: "" }))).toMatch(/context_id/);
  expect(err(body({ bias: "up" }))).toMatch(/bias/);
  expect(err(body({ confidence: "certain" }))).toMatch(/confidence/);
  expect(err(body({ summary: "" }))).toMatch(/summary/);
  expect(err(body({ summary: "x".repeat(601) }))).toMatch(/summary/);
});

test("points are bounded: count, length, cites, types", () => {
  expect(err(body({ bull: "none" }))).toMatch(/bull must be a list/);
  expect(err(body({ bull: Array.from({ length: 7 }, () => point()) }))).toMatch(/at most 6/);
  expect(err(body({ bear: [{ point: "", evidence: "e" }] }))).toMatch(/bear point 1: point/);
  expect(err(body({ bull: [{ point: "p", evidence: "x".repeat(161) }] }))).toMatch(/evidence/);
  expect(err(body({ bull: [{ point: "p", evidence: "e", cites: Array.from({ length: 4 }, () => ({ field: "price", value: "1" })) }] }))).toMatch(/at most 3 cites/);
  expect(err(body({ bull: [{ point: "p", evidence: "e", cites: [{ field: "price" }] }] }))).toMatch(/field and a value/);
  expect(err(body({ watch: [1] }))).toMatch(/watch/);
  expect(err(body({ data_gaps: Array.from({ length: 7 }, () => "g") }))).toMatch(/data_gaps/);
});

test("a point may have no cites (it will be shown as unchecked), and watch and gaps may be left out", () => {
  const r = parseSubmission(body({ bull: [{ point: "Mood is good", evidence: "general" }], watch: undefined, data_gaps: undefined }));
  if ("error" in r) throw new Error(r.error);
  expect(r.submission.result.bull[0]!.cites).toEqual([]);
  expect(r.submission.result.watch).toEqual([]);
});
