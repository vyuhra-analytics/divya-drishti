import { expect, test } from "bun:test";
import { COT_MARKETS, cotPublishedAt, netChange, parseCot, percentileRank } from "./cot";

// two real weeks of Henry Hub natural gas, disaggregated futures only (CFTC Socrata, 2026-10-06 and 2026-10-13)
const rows = [
  { report_date_as_yyyy_mm_dd: "2026-10-13T00:00:00.000", open_interest_all: "1741163", change_in_open_interest_all: "-74827", m_money_positions_long_all: "227211", m_money_positions_short_all: "353692", m_money_positions_spread: "567877", change_in_m_money_long_all: "8453", change_in_m_money_short_all: "-9603", traders_m_money_long_all: "74", traders_m_money_short_all: "47", prod_merc_positions_long: "239597", prod_merc_positions_short: "250478", change_in_prod_merc_long: "-9100", change_in_prod_merc_short: "-6448", swap_positions_long_all: "252964", swap__positions_short_all: "23245", change_in_swap_long_all: "1319", change_in_swap_short_all: "-324", other_rept_positions_long: "50117", other_rept_positions_short: "157214", change_in_other_rept_long: "-3404", change_in_other_rept_short: "11791", nonrept_positions_long_all: "54721", nonrept_positions_short_all: "39981", change_in_nonrept_long_all: "-428", change_in_nonrept_short_all: "1424" },
  { report_date_as_yyyy_mm_dd: "2026-10-06T00:00:00.000", open_interest_all: "1815990", change_in_open_interest_all: "33861", m_money_positions_long_all: "218758", m_money_positions_short_all: "363295", m_money_positions_spread: "626277", change_in_m_money_long_all: "-1764", change_in_m_money_short_all: "9974", prod_merc_positions_long: "248697", prod_merc_positions_short: "256926", swap_positions_long_all: "251645", swap__positions_short_all: "23569", other_rept_positions_long: "53521", other_rept_positions_short: "145423", nonrept_positions_long_all: "55149", nonrept_positions_short_all: "38557" },
  { report_date_as_yyyy_mm_dd: "2026-09-29T00:00:00.000", open_interest_all: "oops" }, // unreadable row: skipped
];

test("parseCot turns CFTC rows into groups with net positions, oldest first", () => {
  const out = parseCot(rows);
  expect(out).toHaveLength(2);
  expect(new Date(out[0].date).toISOString()).toBe("2026-10-06T00:00:00.000Z");
  const last = out[1];
  expect(last.openInterest).toBe(1741163);
  expect(last.managedMoney).toMatchObject({ long: 227211, short: 353692, net: -126481, spread: 567877, tradersLong: 74, tradersShort: 47 });
  expect(last.swapDealers.net).toBe(252964 - 23245);
  expect(last.producers.net).toBe(239597 - 250478);
  expect(last.nonReportable.net).toBe(54721 - 39981);
});

test("netChange is the long change minus the short change, unknown without both", () => {
  const last = parseCot(rows)[1];
  expect(netChange(last.managedMoney)).toBe(8453 + 9603);
  expect(netChange(parseCot(rows)[0].managedMoney)).toBe(-1764 - 9974);
  expect(netChange({ long: 1, short: 1, net: 0, changeLong: 5 })).toBeUndefined();
});

test("percentileRank places a value in its own history", () => {
  const history = Array.from({ length: 100 }, (_, i) => i);
  expect(percentileRank(49, history)).toBe(50);
  expect(percentileRank(-5, history)).toBe(0);
  expect(percentileRank(500, history)).toBe(100);
  expect(percentileRank(1, [1, 2, 3])).toBeUndefined(); // too short to mean anything
});

test("markets and publication time", () => {
  expect(COT_MARKETS.map((m) => m.id)).toEqual(["wti", "brent", "natgas", "rbob"]);
  // Tuesday 13 Oct data is published Friday 16 Oct afternoon New York
  expect(new Date(cotPublishedAt(Date.UTC(2026, 9, 13))).toISOString()).toBe("2026-10-16T19:30:00.000Z");
});
