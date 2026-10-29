import { expect, test } from "bun:test";
import { instrument } from "@drishti/shared";
import { parseScan } from "./tradingview";
import { parseChartQuote } from "./yahoo";
import tvScan from "./fixtures/tv-scan.json";
import yahooCL from "./fixtures/yahoo-chart-CL.json";

test("parseScan maps rows, derives delay and previous close", () => {
  const crude = instrument("MCX:CRUDEOIL")!;
  const ng = instrument("NYMEX:NG")!;
  const targets = new Map([
    ["MCX:CRUDEOIL1!", { inst: crude, contract: "NOV 26" }],
    ["NYMEX:NG1!", { inst: ng }],
  ]);
  const [mcx, nymex] = parseScan(tvScan, targets, 1_000_000);
  expect(mcx).toMatchObject({ symbol: "MCX:CRUDEOIL", price: 9794, open: 9515, high: 9850, low: 9389, volume: 12352, time: 1_000_000, delayedBy: 0, contract: "NOV 26", source: "tradingview" });
  expect(mcx.prevClose).toBeCloseTo(9573, 0); // 9794 / 1.0231
  expect(nymex).toMatchObject({ symbol: "NYMEX:NG", price: 2.969, delayedBy: 600, time: 1_000_000 - 600_000 });
  expect(parseScan({ data: [{ s: "UNKNOWN", d: [1] }] }, targets, 0)).toEqual([]);
});

test("parseChartQuote reads Yahoo meta", () => {
  const q = parseChartQuote(yahooCL, instrument("NYMEX:CL")!);
  expect(q).toMatchObject({ symbol: "NYMEX:CL", price: 98.08, time: 1792515199000, prevClose: 98.54, high: 101.37, low: 95.25, volume: 304580, source: "yahoo", delayedBy: 600 });
  expect(parseChartQuote({ chart: { result: null } }, instrument("NYMEX:CL")!)).toBeNull();
});

import { getJson, newStats, poll, retryAfterMs } from "./provider";

test("retryAfterMs honours the provider's pause, within 5 s and 10 minutes, and defaults to 30 s", () => {
  expect(retryAfterMs("60")).toBe(60_000);
  expect(retryAfterMs("1")).toBe(5_000);
  expect(retryAfterMs("99999")).toBe(600_000);
  expect(retryAfterMs(null)).toBe(30_000);
  expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(30_000); // an HTTP date is not a number of seconds: the default applies
});

test("getJson turns a 429 into an error that carries how long to wait, and other failures into plain ones", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("slow down", { status: 429, headers: { "retry-after": "45" } })) as unknown as typeof fetch;
    const err = (await getJson("https://scanner.example.com/x").catch((e) => e)) as Error & { retryAfterMs?: number };
    expect(err.message).toBe("scanner.example.com 429");
    expect(err.retryAfterMs).toBe(45_000);
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const plain = (await getJson("https://scanner.example.com/x").catch((e) => e)) as Error & { retryAfterMs?: number };
    expect(plain.retryAfterMs).toBeUndefined();
  } finally {
    globalThis.fetch = real;
  }
});

test("poll leaves a provider alone for the pause it asked for after a 429, and keeps its normal pace after any other failure", async () => {
  const stats = newStats();
  const at: number[] = [];
  const stop = poll(20, stats, async () => {
    at.push(Date.now());
    if (at.length === 1) throw Object.assign(new Error("host 429"), { retryAfterMs: 500 });
    if (at.length === 2) throw new Error("host 500");
  });
  await new Promise((r) => setTimeout(r, 900));
  stop();
  expect(at.length).toBeGreaterThanOrEqual(3);
  expect(at[1] - at[0]).toBeGreaterThanOrEqual(480); // waited out the 429 pause
  expect(at[2] - at[1]).toBeLessThan(400); // an ordinary failure is retried at the normal pace (20 ms), far inside the 429 pause
  expect(stats.failed).toBe(2);
});
