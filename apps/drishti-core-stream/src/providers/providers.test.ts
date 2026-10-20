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
