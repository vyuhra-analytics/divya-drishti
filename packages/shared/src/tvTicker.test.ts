import { expect, test } from "bun:test";
import { INSTRUMENTS, tvTickerFor } from "./index";

const crude = INSTRUMENTS.find((i) => i.symbol === "MCX:CRUDEOIL")!;
const cl = INSTRUMENTS.find((i) => i.symbol === "NYMEX:CL")!;
const NOV_19 = Date.UTC(2026, 10, 19);

test("MCX uses the dated contract when the front month is known", () => {
  expect(tvTickerFor(crude, NOV_19)).toBe("MCX:CRUDEOILX2026");
  expect(tvTickerFor(crude, NOV_19, true)).toBe("MCX:CRUDEOILX2026"); // the opt-in changes nothing when the contract is known
});

test("MCX without a front month gets no TradingView ticker: the continuous code is explicit-only", () => {
  expect(tvTickerFor(crude, undefined)).toBeUndefined();
  expect(tvTickerFor(crude, undefined, true)).toBe("MCX:CRUDEOIL1!");
});

test("NYMEX keeps its own continuous code, which is the right contract", () => {
  expect(tvTickerFor(cl, undefined)).toBe("NYMEX:CL1!");
  expect(tvTickerFor(cl, undefined, false)).toBe("NYMEX:CL1!");
});
