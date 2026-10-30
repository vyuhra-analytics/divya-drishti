import { afterEach, expect, test } from "bun:test";
import { INSTRUMENTS, instrument, MAX_CUSTOM_INSTRUMENTS, parseCustomInstrument, setCustomInstruments, SYMBOLS } from "./index";

afterEach(() => setCustomInstruments([]));

const zinc = { exchange: "MCX", root: "zinc", name: "Zinc", decimals: 2, lot: "5000 kg", topic: "crude" };
const ok = (b: unknown) => {
  const r = parseCustomInstrument(b);
  if ("error" in r) throw new Error(r.error);
  return r.instrument;
};
const err = (b: unknown) => {
  const r = parseCustomInstrument(b);
  if ("instrument" in r) throw new Error("accepted");
  return r.error;
};

test("an MCX future gets its time zone, currency, delay and feeds from the exchange, with defaults for the codes", () => {
  expect(ok(zinc)).toMatchObject({ symbol: "MCX:ZINC", currency: "INR", timeZone: "Asia/Kolkata", delayedBy: 0, sources: ["upstox", "tradingview"], upstox: "ZINC", tv: "MCX:ZINC", custom: true });
});

test("a NYMEX future is USD, ten minutes delayed, from Yahoo and TradingView's continuous contract", () => {
  expect(ok({ exchange: "NYMEX", root: "RB", name: "RBOB Gasoline", decimals: 4, lot: "42000 gal", topic: "crude" })).toMatchObject({
    symbol: "NYMEX:RB",
    currency: "USD",
    timeZone: "America/New_York",
    delayedBy: 600,
    sources: ["yahoo", "tradingview"],
    yahoo: "RB=F",
    tv: "NYMEX:RB1!",
  });
});

test("explicit codes are used when given and checked", () => {
  expect(ok({ ...zinc, upstox: "zincmini", tv: "mcx:zincm" })).toMatchObject({ upstox: "ZINCMINI", tv: "MCX:ZINCM" });
  expect(err({ ...zinc, tv: "NYMEX:ZINC1!" })).toMatch(/TradingView root/);
  expect(err({ exchange: "NYMEX", root: "RB", name: "RBOB", decimals: 4, lot: "42000 gal", topic: "crude", yahoo: "RB" })).toMatch(/Yahoo/);
});

test("rejects bad input, one reason each", () => {
  expect(err(null)).toMatch(/exchange/);
  expect(err({ ...zinc, exchange: "NSE" })).toMatch(/exchange/);
  expect(err({ ...zinc, root: "ZI NC" })).toMatch(/root/);
  expect(err({ ...zinc, root: "" })).toMatch(/root/);
  expect(err({ ...zinc, root: "A".repeat(17) })).toMatch(/root/);
  expect(err({ ...zinc, name: "Z" })).toMatch(/name/);
  expect(err({ ...zinc, name: "<script>" })).toMatch(/name/);
  expect(err({ ...zinc, decimals: 5 })).toMatch(/decimals/);
  expect(err({ ...zinc, decimals: 1.5 })).toMatch(/decimals/);
  expect(err({ ...zinc, decimals: "x" })).toMatch(/decimals/);
  expect(err({ ...zinc, lot: "5000" })).toMatch(/lot/);
  expect(err({ ...zinc, lot: "kg 5000" })).toMatch(/lot/);
  expect(err({ ...zinc, topic: "gold" })).toMatch(/topic/);
});

test("a built-in symbol, or one already added, is refused", () => {
  expect(err({ ...zinc, root: "CRUDEOIL" })).toMatch(/already tracked/);
  setCustomInstruments([ok(zinc)]);
  expect(err(zinc)).toMatch(/already tracked/);
});

test("the number of added instruments is capped", () => {
  const many = Array.from({ length: MAX_CUSTOM_INSTRUMENTS }, (_, k) => ok({ ...zinc, root: `Z${k}` }));
  setCustomInstruments(many);
  expect(INSTRUMENTS.filter((i) => i.custom)).toHaveLength(MAX_CUSTOM_INSTRUMENTS);
  expect(err({ ...zinc, root: "EXTRA" })).toMatch(/at most/);
});

test("setCustomInstruments changes the catalogue in place, keeps the eight built-ins, and can be undone", () => {
  const [instruments, symbols] = [INSTRUMENTS, SYMBOLS]; // same arrays before and after: every importer sees the change
  setCustomInstruments([ok(zinc)]);
  expect(INSTRUMENTS).toBe(instruments);
  expect(SYMBOLS).toBe(symbols);
  expect(SYMBOLS).toHaveLength(9);
  expect(instrument("MCX:ZINC")?.name).toBe("Zinc");
  setCustomInstruments([]);
  expect(SYMBOLS).toHaveLength(8);
  expect(instrument("MCX:ZINC")).toBeUndefined();
});

test("setCustomInstruments cannot replace a built-in or add the same symbol twice", () => {
  const crude = { ...INSTRUMENTS[0]!, name: "Hijacked" };
  const z = ok(zinc);
  setCustomInstruments([crude, z, z]);
  expect(instrument("MCX:CRUDEOIL")?.name).toBe("Crude Oil");
  expect(SYMBOLS.filter((s) => s === "MCX:ZINC")).toHaveLength(1);
  expect(SYMBOLS).toHaveLength(9);
});
