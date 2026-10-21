import { afterEach, beforeEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { INSTRUMENTS, instrument, RateLimiter, setCustomInstruments, type Instrument } from "@drishti/shared";
import { formOf, instrumentRoutes } from "./instrumentRoutes";

const ORIGIN = "http://localhost:5173";
let saved: Instrument[];
let open: Set<string>;
let upstoxKnows: boolean;
let changes: number;
let app: { handle(r: Request): Promise<Response> };

beforeEach(() => {
  saved = [];
  open = new Set();
  upstoxKnows = true;
  changes = 0;
  app = new Elysia().use(instrumentRoutes({
    origins: [ORIGIN],
    limiter: new RateLimiter(100, 60_000),
    upstoxHasFuture: async () => upstoxKnows,
    hasOpenPosition: async (s) => open.has(s),
    save: async (i) => void saved.push(i),
    remove: async (s) => void (saved = saved.filter((i) => i.symbol !== s)),
    changed: async () => {
      changes++;
      setCustomInstruments(saved); // what the stream does after reloading the table
    },
  }));
});
afterEach(() => setCustomInstruments([]));

// the test preload swaps in happy-dom's Request, which drops the forbidden Origin header at construction; setting it afterwards works
const req = (url: string, init: RequestInit, origin: string | null) => {
  const r = new Request(url, init);
  if (origin) r.headers.set("origin", origin);
  return r;
};
const call = (path: string, init: RequestInit = {}, origin: string | null = ORIGIN) =>
  app.handle(req(`http://localhost/instruments${path}`, { ...init, headers: init.body ? { "content-type": "application/json" } : {} }, origin));
const zinc = { exchange: "MCX", root: "ZINC", name: "Zinc", decimals: 2, lot: "5000 kg", topic: "crude" };
const post = (b: unknown, origin: string | null = ORIGIN) => call("", { method: "POST", body: JSON.stringify(b) }, origin);

test("adds a valid instrument: saved, catalogue reloaded, 201", async () => {
  const r = await post(zinc);
  expect(r.status).toBe(201);
  expect(saved.map((i) => i.symbol)).toEqual(["MCX:ZINC"]);
  expect(changes).toBe(1);
  expect(instrument("MCX:ZINC")?.custom).toBe(true);
  const list = (await (await call("")).json()) as { instruments: Instrument[] };
  expect(list.instruments).toHaveLength(7);
});

test("bad input is a 400 and nothing is saved", async () => {
  for (const b of [null, {}, { ...zinc, exchange: "NSE" }, { ...zinc, lot: "big" }, { ...zinc, root: "CRUDEOIL" }]) {
    const r = await post(b);
    expect(r.status).toBe(400);
  }
  expect(saved).toHaveLength(0);
  expect(changes).toBe(0);
});

test("an MCX underlying Upstox does not list is refused with a reason", async () => {
  upstoxKnows = false;
  const r = await post(zinc);
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toMatch(/Upstox lists no ZINC/);
  expect(saved).toHaveLength(0);
});

test("a NYMEX instrument is not checked against Upstox", async () => {
  upstoxKnows = false;
  const r = await post({ exchange: "NYMEX", root: "RB", name: "RBOB Gasoline", decimals: 4, lot: "42000 gal", topic: "crude" });
  expect(r.status).toBe(201);
});

test("built-ins cannot be removed; unknown symbols are 404", async () => {
  expect((await call(`/${encodeURIComponent("MCX:CRUDEOIL")}`, { method: "DELETE" })).status).toBe(403);
  expect((await call(`/${encodeURIComponent("MCX:NOPE")}`, { method: "DELETE" })).status).toBe(404);
  expect(INSTRUMENTS.some((i) => i.symbol === "MCX:CRUDEOIL")).toBe(true);
});

test("an added instrument is removed, unless a paper position is open in it", async () => {
  await post(zinc);
  open.add("MCX:ZINC");
  const blocked = await call(`/${encodeURIComponent("MCX:ZINC")}`, { method: "DELETE" });
  expect(blocked.status).toBe(409);
  expect(saved).toHaveLength(1);
  open.clear();
  const r = await call(`/${encodeURIComponent("MCX:ZINC")}`, { method: "DELETE" });
  expect(r.status).toBe(200);
  expect(saved).toHaveLength(0);
  expect(instrument("MCX:ZINC")).toBeUndefined();
});

test("a foreign website is refused for every method; a caller with no Origin (the API service) is served", async () => {
  expect((await post(zinc, "https://evil.example")).status).toBe(403);
  expect((await call("", {}, "https://evil.example")).status).toBe(403);
  expect((await call(`/${encodeURIComponent("MCX:ZINC")}`, { method: "DELETE" }, "https://evil.example")).status).toBe(403);
  expect(saved).toHaveLength(0);
  expect((await call("", {}, null)).status).toBe(200);
});

test("requests are rate limited", async () => {
  const limited = new Elysia().use(instrumentRoutes({ origins: [ORIGIN], limiter: new RateLimiter(2, 60_000), upstoxHasFuture: async () => true, hasOpenPosition: async () => false, save: async () => undefined, remove: async () => undefined, changed: async () => undefined }));
  const get = () => limited.handle(req("http://localhost/instruments", {}, ORIGIN));
  expect((await get()).status).toBe(200);
  expect((await get()).status).toBe(200);
  expect((await get()).status).toBe(429);
});

test("the stored form rebuilds the same instrument (what is re-validated at every load)", async () => {
  await post({ ...zinc, upstox: "ZINCMINI" });
  const [i] = saved;
  expect(formOf(i!)).toMatchObject({ exchange: "MCX", root: "ZINC", upstox: "ZINCMINI", tv: "MCX:ZINC" });
});
