import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { suggestStrike } from "@drishti/shared";
import { StrikeBlock } from "./StrikeBlock";
import { useStore } from "./store";

const leg = (delta: number, ask: number, oi: number, ukey: string) => ({ key: "k", ukey, ask, bid: ask - 5, ltp: ask, delta, theta: -5, iv: 40, oi, volume: 50 });
const chain = { underlying: "CRUDEOIL", expiry: "2026-11-17", expiries: [], atm: 9600, spot: 9620, lot: 100, updatedAt: 0, rows: [[9500, 0.62, 240, 100, 7000], [9550, 0.57, 200, 200, 300], [9600, 0.52, 170, 300, 400], [9650, 0.46, 140, 9000, 20], [9700, 0.4, 110, 400, 10]].map(([strike, d, ask, ce, pe]) => ({ strike, ce: leg(d, ask, ce, `MCX_FO|${strike}C`), pe: leg(-d, ask, pe, `MCX_FO|${strike}P`) })) };

beforeEach(() => act(() => void useStore.setState({ options: {} })));
afterEach(cleanup);

test("five strikes with the pick, its cost and the nearest open-interest walls", () => {
  render(<StrikeBlock strike={suggestStrike(chain as never, "long")} chain={chain as never} side="long" price={9620} />);
  expect(screen.getByText("Option to buy (long)")).toBeTruthy();
  expect(document.querySelectorAll(".rd-table tbody tr")).toHaveLength(5);
  expect(screen.getByText("9600 CE")).toBeTruthy();
  expect(screen.getByText(/₹17,000 for one lot/)).toBeTruthy();
  const walls = document.querySelector(".rd-walls")!.textContent!;
  expect(walls).toContain("calls 9650 (9,000) above"); // the biggest call open interest at or above 9620
  expect(walls).toContain("puts 9500 (7,000) below");
  expect(walls).toContain("premiums from the poll");
});

test("a live option quote under ten seconds old replaces the polled premium and is marked; an old one is ignored", () => {
  act(() => void useStore.setState({ options: { "MCX_FO|9600C": { key: "MCX_FO|9600C", price: 171, ask: 173.5, time: Date.now(), recvAt: Date.now() }, "MCX_FO|9650C": { key: "MCX_FO|9650C", price: 150, ask: 152, time: 0, recvAt: Date.now() - 60_000 } } as never }));
  render(<StrikeBlock strike={suggestStrike(chain as never, "long")} chain={chain as never} side="long" price={9620} />);
  const rows = Array.from(document.querySelectorAll(".rd-table tbody tr"));
  expect(rows[2].textContent).toContain("173.5"); // 9600: the live ask
  expect(rows[2].querySelector(".up")).toBeTruthy();
  expect(rows[3].textContent).toContain("140.0"); // 9650: the live quote is a minute old, the poll is used
  expect(rows[3].querySelector(".up")).toBeNull();
  expect(document.querySelector(".rd-walls")!.textContent).toContain("1 of 5 premiums live");
});

test("without a chain it says so", () => {
  render(<StrikeBlock strike={suggestStrike(null, "long")} chain={null} />);
  expect(screen.getByText("No option chain yet.")).toBeTruthy();
});
