import { expect, test } from "bun:test";
import { ENERGY_UNIVERSE, parseUniverseScan, UNIVERSE_GROUPS } from "./universe";

test("universe: unique tickers, every group used, our instruments linked", () => {
  expect(new Set(ENERGY_UNIVERSE.map((u) => u.tv)).size).toBe(ENERGY_UNIVERSE.length);
  expect(new Set(ENERGY_UNIVERSE.map((u) => u.group))).toEqual(new Set(UNIVERSE_GROUPS));
  expect(ENERGY_UNIVERSE.filter((u) => u.symbol).map((u) => u.symbol)).toEqual([
    "MCX:CRUDEOIL",
    "MCX:CRUDEOILM",
    "MCX:NATURALGAS",
    "MCX:NATGASMINI",
    "NYMEX:CL",
    "NYMEX:NG",
  ]);
});

test("parseUniverseScan maps rows, resolves dated MCX codes, skips unknown/empty", () => {
  const json = {
    data: [
      { s: "MCX:CRUDEOILX2026", d: [9311, -1.5, 48327, null, 9900, 5200, "streaming"] },
      { s: "NYSE:XOM", d: [177.86, -0.24, 13500338, 731.3e9, 180.26, 112.51, "delayed_streaming_900"] },
      { s: "NOT:OURS", d: [1, 0, 0, 0, 0, 0, "streaming"] },
      { s: "NYMEX:RB1!", d: [null, 0, 0, null, 0, 0, "streaming"] },
    ],
  };
  const resolve = (s: string) => (s === "MCX:CRUDEOILX2026" ? "MCX:CRUDEOIL" : ENERGY_UNIVERSE.find((u) => u.tv === s)?.tv);
  expect(parseUniverseScan(json, resolve)).toEqual([
    { tv: "MCX:CRUDEOIL", price: 9311, changePct: -1.5, volume: 48327, marketCap: undefined, high52: 9900, low52: 5200, delayedBy: 0 },
    { tv: "NYSE:XOM", price: 177.86, changePct: -0.24, volume: 13500338, marketCap: 731.3e9, high52: 180.26, low52: 112.51, delayedBy: 900 },
  ]);
});
