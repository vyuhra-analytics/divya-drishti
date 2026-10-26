import { describe, expect, it } from "bun:test";
import { recordedChain, type SnapshotContract } from "./recordedChain";

const book = (bid: number, ask: number) => ({ buy: [{ quantity: 4, price: bid }, { quantity: 0, price: 0 }], sell: [{ quantity: 6, price: ask }] });
const opt = (key: string, side: "CE" | "PE", strike: number, over: Partial<SnapshotContract> = {}): SnapshotContract => ({ key, side, expiry: "2026-11-17", strike, lot: 100, underlyingKey: "F1", lastPrice: 100, oi: 1000, volume: 50, ...over });
const rows: SnapshotContract[] = [
  { key: "F1", side: "FUT", expiry: "2026-11-19", strike: 0, lastPrice: 9614 },
  opt("c9500", "CE", 9500, { oi: 2000, depth: book(99, 101), iv: 56.4, delta: 0.6, lowerCircuit: 8, upperCircuit: 2000, netChange: -12 }),
  opt("p9500", "PE", 9500, { oi: 3000 }),
  opt("c9600", "CE", 9600, { oi: 500 }),
  opt("p9600", "PE", 9600, { oi: 800 }),
  opt("c9700", "CE", 9700, { oi: 100 }),
  opt("p9700", "PE", 9700, { oi: 100 }),
  opt("c-dec", "CE", 9600, { expiry: "2026-12-16", underlyingKey: "F2" }),
];

describe("recordedChain", () => {
  it("builds the chain of the first expiry: spot from the settling future, ATM, PCR, max pain, bid and ask from the book", () => {
    const c = recordedChain({ underlying: "CRUDEOIL", asOf: 1000, rows, strikesEachSide: 1 })!;
    expect(c.expiries).toEqual(["2026-11-17", "2026-12-16"]);
    expect(c.expiry).toBe("2026-11-17");
    expect(c.spot).toBe(9614);
    expect(c.atm).toBe(9600);
    expect(c.rows.map((r) => r.strike)).toEqual([9500, 9600, 9700]);
    expect(c.pcr).toBeCloseTo((3000 + 800 + 100) / (2000 + 500 + 100), 10);
    expect(c.maxPain).toBeDefined();
    const l = c.rows[0].ce!;
    expect(l).toMatchObject({ bid: 99, ask: 101, bidQty: 4, askQty: 6, iv: 56.4, delta: 0.6, lowerCircuit: 8, upperCircuit: 2000, change: -12 });
    expect(c).toMatchObject({ source: "upstox", asOf: 1000, updatedAt: 1000, prevAt: null, nextAt: null, lot: 100 });
  });

  it("picks the asked expiry, and falls back to the first when it is not in the snapshot", () => {
    expect(recordedChain({ underlying: "CRUDEOIL", expiry: "2026-12-16", asOf: 1, rows })!.expiry).toBe("2026-12-16");
    expect(recordedChain({ underlying: "CRUDEOIL", expiry: "2030-01-01", asOf: 1, rows })!.expiry).toBe("2026-11-17");
  });

  it("measures OI change against the first snapshot of the day only when there is a baseline, and says so", () => {
    const base = new Map([["c9500", 1500], ["p9500", 3500]]);
    const c = recordedChain({ underlying: "CRUDEOIL", asOf: 1, rows, strikesEachSide: 1, baseline: base })!;
    expect(c.oiBasis).toBe("session-open");
    expect(c.rows[0].ce).toMatchObject({ prevOi: 1500, oiChange: 500 });
    expect(c.rows[0].pe).toMatchObject({ prevOi: 3500, oiChange: -500 });
    expect(c.rows[1].ce?.oiChange).toBeUndefined(); // no baseline for this contract
    expect(recordedChain({ underlying: "CRUDEOIL", asOf: 1, rows })!.oiBasis).toBeUndefined();
  });

  it("an untraded contract has no price or change, only its book; with no future the spot is unknown", () => {
    const quiet = [opt("c1", "CE", 9600, { lastPrice: 0, netChange: -5775, depth: book(5024, 6082) })];
    const c = recordedChain({ underlying: "CRUDEOIL", asOf: 1, rows: quiet })!;
    expect(c.spot).toBeUndefined();
    expect(c.atm).toBeUndefined();
    expect(c.rows[0].ce).toMatchObject({ ltp: undefined, change: undefined, bid: 5024, ask: 6082 });
  });

  it("returns nothing when the snapshot holds no options", () => expect(recordedChain({ underlying: "CRUDEOIL", asOf: 1, rows: [rows[0]] })).toBeUndefined());
});
