import { afterEach, expect, test } from "bun:test";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { ChokepointsController } from "./chokepoints.controller";
import { CotController } from "./cot.controller";
import { CurveController } from "./curve.controller";
import { EiaController } from "./eia.controller";
import { MarketController } from "./market.controller";

// Every endpoint refuses bad input with a 400 BEFORE it touches the network or the database; the live smoke test (bun run smoke)
// covers the same refusals over HTTP. A database that is never reached proves nothing was attempted.
const neverDb = { sql: () => Promise.reject(new Error("the database must not be touched")), redis: { get: () => Promise.reject(new Error("redis must not be touched")) } } as any;

const refused = async (call: () => unknown) => {
  const err = await Promise.resolve()
    .then(call)
    .catch((e) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  return err as BadRequestException;
};

test("COT: market and weeks are validated", async () => {
  const c = new CotController();
  expect((await refused(() => c.cot("nope"))).message).toMatch(/market must be one of/);
  for (const weeks of ["1", "9", "521", "abc", "10.5"]) await refused(() => c.cot("wti", weeks));
});

test("chokepoints: id and days are validated", async () => {
  const c = new ChokepointsController();
  await refused(() => c.transits("x"));
  for (const days of ["5", "29", "1001", "abc"]) await refused(() => c.transits("hormuz", days));
});

test("curve: only our instruments", async () => {
  const c = new CurveController();
  expect((await refused(() => c.curve("DOGE"))).message).toMatch(/symbol must be one of/);
  await refused(() => c.curve("MCX:CRUDEOIL; DROP TABLE"));
});

test("calendar: days must be a whole number from 1 to 60", async () => {
  const c = new CalendarController(neverDb);
  for (const days of ["0", "61", "1.5", "abc", "-3"]) await refused(() => c.events(days));
});

test("bars: unknown symbol or timeframe is refused", async () => {
  const c = new MarketController(neverDb);
  expect((await refused(() => c.bars("DOGE"))).message).toMatch(/unknown symbol/);
  expect((await refused(() => c.bars("MCX:CRUDEOIL", "9x"))).message).toMatch(/tf must be one of/);
});

const savedKey = process.env.EIA_API_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.EIA_API_KEY;
  else process.env.EIA_API_KEY = savedKey;
});

test("EIA without a key is a 503 that says how to get one, and never calls EIA", async () => {
  delete process.env.EIA_API_KEY;
  const err = await new EiaController().eia().catch((e) => e);
  expect(err).toBeInstanceOf(ServiceUnavailableException);
  expect(err.message).toContain("EIA_API_KEY");
  expect(err.message).toContain("eia.gov/opendata");
});
