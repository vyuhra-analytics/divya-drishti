import { expect, test } from "bun:test";
import { parse, suggest } from "./command";

const SYMS = ["NIFTY", "BANKNIFTY", "TCS", "INFY"];

test("parse symbol, mnemonic, both, in any order and case", () => {
  expect(parse("tcs", SYMS)).toEqual({ ok: true, cmd: { symbol: "TCS" } });
  expect(parse("GP", SYMS)).toEqual({ ok: true, cmd: { open: "chart" } });
  expect(parse("  infy  gp ", SYMS)).toEqual({ ok: true, cmd: { symbol: "INFY", open: "chart" } });
  expect(parse("Q TCS", SYMS)).toEqual({ ok: true, cmd: { symbol: "TCS", open: "quote" } });
});

test("parse rejects unknown, duplicate and empty input with suggestions", () => {
  expect(parse("NIF", SYMS)).toEqual({ ok: false, error: 'unknown "NIF"', suggestions: ["NIFTY", "BANKNIFTY"] });
  expect(parse("TCS INFY", SYMS)).toMatchObject({ ok: false, error: 'unknown "INFY"' });
  expect(parse("", SYMS)).toMatchObject({ ok: false, suggestions: SYMS });
});

test("suggest ranks prefix before substring", () => {
  expect(suggest("n", SYMS)).toEqual(["NIFTY", "BANKNIFTY", "INFY"]);
  expect(suggest("zz", SYMS)).toEqual([]);
});

test("parse accepts exchange-less short codes", () => {
  const syms = ["MCX:CRUDEOIL", "MCX:CRUDEOILM", "NYMEX:CL", "NYMEX:NG"];
  expect(parse("crudeoil", syms)).toEqual({ ok: true, cmd: { symbol: "MCX:CRUDEOIL" } });
  expect(parse("CL GP", syms)).toEqual({ ok: true, cmd: { symbol: "NYMEX:CL", open: "chart" } });
  expect(parse("nymex:ng", syms)).toEqual({ ok: true, cmd: { symbol: "NYMEX:NG" } });
});
