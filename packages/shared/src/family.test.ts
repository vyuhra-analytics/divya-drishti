import { describe, expect, test } from "bun:test";
import { chargeGroup, familyCsv, fyOf, maskCode, monthlyView, toCsv, overlaps, parseSymbol, periodFy, summarize, type FamilyAccount, type FamilyMember, type ImportRecord } from "./family";
import { matchFills, reconcileWithStatement, realizedByMonth } from "./fifo";
import { readXlsx } from "./xlsx";
import { parseZerodhaPnl } from "./zerodhaPnl";
import { parseZerodhaTradebook, type Fill } from "./zerodhaTradebook";
import { makeXlsx } from "./xlsxTestUtil";

// Invented numbers throughout: a family's real statements are never committed. The layouts are the ones seen in real Zerodha Console files.
const pnlSheets = (over: { realized?: number; charges?: number } = {}) => [
  {
    name: "F&O",
    rows: [
      [],
      [], [], [], [], [],
      [null, "Client ID", "AB1234"],
      [], [], [],
      [null, "P&L Statement for F&O from 2024-04-01 to 2024-10-28"],
      [],
      [null, "Summary"],
      [],
      [null, "Charges", over.charges ?? 30],
      [null, "Other Credit & Debit", 0],
      [null, "Realized P&L", over.realized ?? 700],
      [null, "Unrealized P&L", 0],
      [], [],
      [null, "Charges"],
      [],
      [null, "Account Head", "Amount"],
      [null, "Brokerage - Z", 20],
      [null, "Integrated GST - Z", 3.6],
      [null, "Securities Transaction Tax - Z", 6],
      [null, "SEBI Turnover Fees - Z", 0.4],
      [], [], [], [], [], [], [], [],
      [null, "Symbol", "ISIN", "Quantity", "Buy Value", "Sell Value", "Realized P&L", "Realized P&L Pct.", "Previous Closing Price", "Open Quantity", "Open Quantity Type", "Open Value", "Unrealized P&L"],
      [null, "NIFTY2462023600CE", null, 25, 1000, 1500, 500, 50, 0, 0, null, 0, 0],
      [null, "BANKNIFTY2461951100PE", null, 15, 300, 500, 200, 66, 0, 0, null, 0, 0],
    ],
  },
  { name: "Other Debits and Credits", rows: [[], [], [], [], [], [], [null, "Client ID", "AB1234"], [], [], [], [null, "Other Debits and Credits for FO from 2024-04-01 to 2024-10-28"], [], [], [], [null, "Particulars", "Posting Date", "Debit", "Credit"]] },
];

const tradebookSheets = (rows: (string | number)[][]) => [
  {
    name: "F&O",
    rows: [[], [], [], [], [], [], [null, "Client ID", "AB1234"], [], [], [], [null, "Tradebook for F&O from 2024-04-01 to 2024-10-28"], [], [], [], [null, "Symbol", "ISIN", "Trade Date", "Exchange", "Segment", "Series", "Trade Type", "Auction", "Quantity", "Price", "Trade ID", "Order ID", "Order Execution Time"], ...rows.map((r) => [null, ...r])],
  },
];
// symbol, isin, date, exchange, segment, series, side, auction, qty, price, trade id, order id, time
const fill = (symbol: string, date: string, side: string, qty: number, price: number, id: string): (string | number)[] => [symbol, "", date, "NSE", "FO", "", side, 0, qty, price, id, "o" + id, `${date}T10:00:00`];

describe("the workbook reader", () => {
  test("reads sheets, strings, numbers and blank rows from a real zip", async () => {
    const bytes = makeXlsx([{ name: "A & B", rows: [["x", 1.5], [], [null, "y"]] }]);
    const sheets = await readXlsx(bytes);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe("A & B");
    expect(sheets[0].rows[0]).toEqual(["x", 1.5]);
    expect(sheets[0].rows[1]).toEqual([]);
    expect(sheets[0].rows[2]).toEqual([null, "y"]);
  });
  test("refuses what is not a workbook, with a plain reason", async () => {
    await expect(readXlsx(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not an .xlsx/);
    await expect(readXlsx(new Uint8Array())).rejects.toThrow(/empty/);
  });
});

describe("Zerodha P&L statement", () => {
  test("reads the period, segment, charges, lines and the client code", async () => {
    const r = parseZerodhaPnl(await readXlsx(makeXlsx(pnlSheets())));
    expect(r.segment).toBe("fno");
    expect([r.periodFrom, r.periodTo]).toEqual(["2024-04-01", "2024-10-28"]);
    expect(r.clientCode).toBe("AB1234");
    expect(r.lines.map((l) => l.realized)).toEqual([500, 200]);
    expect(r.charges.reduce((a, c) => a + c.amount, 0)).toBeCloseTo(30);
    expect(r.problems).toEqual([]);
  });
  test("a total that is not the sum of its rows is reported, not absorbed", async () => {
    const r = parseZerodhaPnl(await readXlsx(makeXlsx(pnlSheets({ realized: 650, charges: 31 }))));
    expect(r.problems.length).toBe(2);
    expect(r.problems.join(" ")).toMatch(/add up to a realised P&L of 700/);
    expect(r.problems.join(" ")).toMatch(/charges add up to 30/);
  });
  test("refuses a report it was not built for", async () => {
    expect(() => parseZerodhaPnl([{ name: "x", rows: [[null, "hello"]] }])).toThrow(/not a Zerodha P&L/);
    const odd = pnlSheets();
    odd[0].rows[10] = [null, "P&L Statement for Mutual Funds from 2024-04-01 to 2024-10-28"];
    expect(() => parseZerodhaPnl(odd)).toThrow(/not supported yet/);
  });
});

describe("Zerodha tradebook", () => {
  test("reads fills and skips a repeated trade id with a note", () => {
    const tb = parseZerodhaTradebook(tradebookSheets([fill("NIFTY2462023600CE", "2024-06-20", "buy", 25, 40, "1"), fill("NIFTY2462023600CE", "2024-06-20", "buy", 25, 40, "1")]));
    expect(tb.fills).toHaveLength(1);
    expect(tb.notes[0]).toMatch(/appears twice/);
    expect(tb.clientCode).toBe("AB1234");
  });
  test("a bad trade type or quantity is an error naming the trade", () => {
    expect(() => parseZerodhaTradebook(tradebookSheets([fill("X", "2024-06-20", "hold", 25, 40, "1")]))).toThrow(/trade type "hold"/);
    expect(() => parseZerodhaTradebook(tradebookSheets([fill("X", "2024-06-20", "buy", 0, 40, "1")]))).toThrow(/bad quantity/);
  });
});

describe("first-in-first-out matching", () => {
  const f = (symbol: string, date: string, side: "buy" | "sell", quantity: number, price: number, tradeId: string): Fill => ({ symbol, date, time: null, side, quantity, price, tradeId, exchange: "NSE" });
  test("closes the oldest lot first and keeps the rest open", () => {
    const m = matchFills([f("A", "2024-06-01", "buy", 10, 100, "1"), f("A", "2024-06-02", "buy", 10, 110, "2"), f("A", "2024-06-03", "sell", 15, 120, "3")]);
    expect(m.closed.map((c) => [c.quantity, c.pnl])).toEqual([[10, 200], [5, 50]]);
    expect(m.open).toEqual([{ symbol: "A", direction: "long", quantity: 5, openDate: "2024-06-02", openPrice: 110 }]);
  });
  test("a short is sold first and bought back", () => {
    const m = matchFills([f("A", "2024-06-01", "sell", 10, 100, "1"), f("A", "2024-06-02", "buy", 10, 90, "2")]);
    expect(m.closed).toHaveLength(1);
    expect(m.closed[0]).toMatchObject({ direction: "short", pnl: 100 });
  });
  test("a fill bigger than the position closes it and opens the other way", () => {
    const m = matchFills([f("A", "2024-06-01", "buy", 10, 100, "1"), f("A", "2024-06-02", "sell", 15, 110, "2")]);
    expect(m.closed[0].pnl).toBe(100);
    expect(m.open[0]).toMatchObject({ direction: "short", quantity: 5 });
  });
  test("the order of the input does not matter", () => {
    const fills = [f("A", "2024-06-01", "buy", 10, 100, "1"), f("A", "2024-06-03", "sell", 10, 120, "3"), f("B", "2024-06-02", "buy", 5, 50, "2")];
    expect(matchFills([...fills].reverse())).toEqual(matchFills(fills));
  });
  test("reconciles with a statement and shows the symbol that differs", () => {
    const m = matchFills([f("A", "2024-06-01", "buy", 10, 100, "1"), f("A", "2024-06-03", "sell", 10, 120, "3")]);
    const ok = reconcileWithStatement(m, [{ symbol: "A", quantity: 10, buyValue: 1000, sellValue: 1200, realized: 200, openQuantity: 0, unrealized: 0 }]);
    expect(ok.every((r) => r.ok)).toBe(true);
    const bad = reconcileWithStatement(m, [{ symbol: "A", quantity: 10, buyValue: 1000, sellValue: 1100, realized: 100, openQuantity: 0, unrealized: 0 }]);
    expect(bad[0]).toMatchObject({ ok: false, difference: 100 });
    expect(realizedByMonth(m.closed)).toEqual([{ month: "2024-06", pnl: 200, closes: 1 }]);
  });
});

describe("symbols, years and charge groups", () => {
  test("parses weekly, monthly and future symbols", () => {
    expect(parseSymbol("BANKNIFTY2461951100CE")).toEqual({ underlying: "BANKNIFTY", kind: "option", optionType: "CE", strike: 51100, expiryMonth: "2024-06", expiryDate: "2024-06-19" });
    expect(parseSymbol("FINNIFTY2470223350PE")).toMatchObject({ underlying: "FINNIFTY", strike: 23350, optionType: "PE" });
    expect(parseSymbol("MIDCPNIFTY24JUN12275CE")).toMatchObject({ underlying: "MIDCPNIFTY", strike: 12275 });
    expect(parseSymbol("NIFTY24JULFUT")).toEqual({ underlying: "NIFTY", kind: "future", expiryMonth: "2024-07", expiryDate: "2024-07-31" }); // a monthly name has no day: the last day of the month
    expect(parseSymbol("RELIANCE")).toEqual({ underlying: "RELIANCE", kind: "other" });
  });
  test("the expiry month is read from the name in every format the two brokers use", () => {
    expect(parseSymbol("FINNIFTY2470223350PE").expiryMonth).toBe("2024-07"); // weekly: 24 7 02
    expect(parseSymbol("NIFTY24O1024000CE").expiryMonth).toBe("2024-10"); // the weekly month letters: O, N, D
    expect(parseSymbol("NIFTY24N0724000CE").expiryMonth).toBe("2024-11");
    expect(parseSymbol("NIFTY24D1224000CE").expiryMonth).toBe("2024-12");
    expect(parseSymbol("MIDCPNIFTY24JUN12275CE").expiryMonth).toBe("2024-06"); // monthly
    expect(parseSymbol("CRUDEOILM24NOVFUT").expiryMonth).toBe("2024-11");
    expect(parseSymbol("BANKNIFTY      24DEC24    CE 52700").expiryMonth).toBe("2024-12"); // Kotak
    expect(parseSymbol("SENSEX 04Jun26 CE 76200").expiryMonth).toBe("2026-06"); // Kotak, mixed case
    expect(parseSymbol("NIFTY 26DEC24 FUT").expiryMonth).toBe("2024-12");
    expect(parseSymbol("RELIANCE").expiryMonth).toBeUndefined();
  });
  test("financial year runs April to March", () => {
    expect(fyOf("2024-03-31")).toBe("2023-24");
    expect(fyOf("2024-04-01")).toBe("2024-25");
    expect(periodFy("2024-04-01", "2024-10-28")).toBe("2024-25");
    expect(periodFy("2024-01-01", "2024-10-28")).toBe("2024-01-01 to 2024-10-28");
    expect(overlaps({ from: "2024-04-01", to: "2024-06-30" }, { from: "2024-06-30", to: "2024-09-30" })).toBe(true);
    expect(overlaps({ from: "2024-04-01", to: "2024-06-29" }, { from: "2024-06-30", to: "2024-09-30" })).toBe(false);
  });
  test("masks a client code for the screen", () => {
    expect(maskCode("PZG888")).toBe("***888");
    expect(maskCode("AB")).toBe("**");
    expect(maskCode("")).toBe("");
  });
  test("groups the broker's charge heads", () => {
    expect(chargeGroup("Brokerage - Z")).toBe("Brokerage");
    expect(chargeGroup("Integrated GST - Z")).toBe("GST");
    expect(chargeGroup("Central GST - Z")).toBe("GST");
    expect(chargeGroup("Securities Transaction Tax - Z")).toBe("STT / CTT");
    expect(chargeGroup("Exchange Transaction Charges - Z")).toBe("Exchange");
    expect(chargeGroup("SEBI Turnover Fees - Z")).toBe("SEBI");
    expect(chargeGroup("Mystery")).toBe("Other");
  });
});

describe("CSV export", () => {
  test("quotes, doubles quotes and defuses text that looks like a formula, numbers stay numbers", () => {
    expect(toCsv([["a,b", 'say "hi"', "=SUM(A1)", "-x", -5, 1.5]])).toBe('"a,b","say ""hi""",\'=SUM(A1),\'-x,-5,1.5\r\n');
  });
  test("carries the names typed, the totals and the months, and never a client id", () => {
    const members: FamilyMember[] = [{ id: 1, nickname: "Dad", relation: "", hidden: false, note: "" }];
    const accounts: FamilyAccount[] = [{ id: 10, memberId: 1, broker: "zerodha", label: "main", clientCode: "SECRET99" }];
    const imp: ImportRecord = { id: 1, accountId: 10, kind: "pnl", segment: "fno", periodFrom: "2024-04-01", periodTo: "2024-10-28", fileName: "x.xlsx", importedAt: "", summary: { charges: 30, otherCreditDebit: 0, realized: 700, unrealized: 0 }, lines: [{ symbol: "NIFTY2462023600CE", quantity: 25, buyValue: 0, sellValue: 700, realized: 700, openQuantity: 0, unrealized: 0 }], charges: [{ head: "Brokerage - Z", amount: 30 }], fills: [], problems: [] };
    const csv = familyCsv({ summary: summarize(members, accounts, [imp]), monthly: monthlyView(members, accounts, [imp]) }, { member: () => "Dad", account: () => "Dad - Zerodha - main" });
    expect(csv).toContain("Financial year,Realised,Charges,Net");
    expect(csv).toContain("2024-25,700,30,670");
    expect(csv).toContain("Dad,700,30,670");
    expect(csv).toContain("Brokerage,30");
    expect(csv).not.toContain("SECRET99");
  });
});

describe("summary and monthly view", () => {
  const members: FamilyMember[] = [{ id: 1, nickname: "Dad", relation: "father", hidden: false, note: "" }, { id: 2, nickname: "Sis", relation: "sister", hidden: false, note: "" }];
  const accounts: FamilyAccount[] = [{ id: 10, memberId: 1, broker: "zerodha", label: "main", clientCode: "AB1234" }, { id: 20, memberId: 2, broker: "zerodha", label: "main", clientCode: "ZZ9999" }];
  const stmt = (id: number, accountId: number, realized: number, charges: number, from = "2024-04-01", to = "2025-03-31"): ImportRecord => ({
    id, accountId, kind: "pnl", segment: "fno", periodFrom: from, periodTo: to, fileName: `s${id}.xlsx`, importedAt: "", summary: { charges, otherCreditDebit: 0, realized, unrealized: 0 },
    lines: [{ symbol: "NIFTY2462023600CE", quantity: 25, buyValue: 0, sellValue: realized, realized, openQuantity: 0, unrealized: 0 }], charges: [{ head: "Brokerage - Z", amount: charges }], fills: [], problems: [],
  });
  test("totals, net and the cuts by member and period", () => {
    const s = summarize(members, accounts, [stmt(1, 10, -1000, 50), stmt(2, 20, 400, 30)]);
    expect(s.totals).toMatchObject({ realized: -600, charges: 80, net: -680, losers: 1, winners: 1 });
    expect(s.byMember.map((m) => [m.label, m.net])).toEqual([["Dad", -1050], ["Sis", 370]]);
    expect(s.byPeriod).toHaveLength(1);
    expect(s.byPeriod[0].key).toBe("2024-25");
    expect(s.byUnderlying[0].label).toBe("NIFTY");
    expect(summarize(members, accounts, [stmt(1, 10, -1000, 50), stmt(2, 20, 400, 30)], { memberId: 2 }).totals.net).toBe(370);
  });
  test("a calendar-year statement is cut into financial years by its tradebook, and left whole without one", () => {
    const fill = (date: string, side: "buy" | "sell", price: number, id: string) => ({ symbol: "NIFTY2462023600CE", date, time: null, side, quantity: 25, price, tradeId: id, exchange: "NSE" }) as const;
    // +250 closed in Feb 2024 (FY 2023-24), -1000 closed in Jun 2024 (FY 2024-25); the statement covers Jan to Dec 2024
    const book: ImportRecord = { ...stmt(3, 10, 0, 0, "2024-01-01", "2024-12-31"), kind: "tradebook", lines: [], charges: [], fills: [fill("2024-02-10", "buy", 40, "a"), fill("2024-02-10", "sell", 50, "b"), fill("2024-06-20", "buy", 100, "c"), fill("2024-06-20", "sell", 60, "d")] };
    const st = stmt(1, 10, -750, 100, "2024-01-01", "2024-12-31");
    const s = summarize(members, accounts, [st, book]);
    expect(s.byPeriod.map((p) => [p.key, p.realized])).toEqual([["2023-24", 250], ["2024-25", -1000]]);
    expect(s.totals).toMatchObject({ realized: -750, charges: 100, net: -850 });
    expect(s.byPeriod.reduce((a, p) => a + p.charges, 0)).toBeCloseTo(100, 6);
    expect(summarize(members, accounts, [st, book], { period: "2024-25" }).totals.realized).toBe(-1000);
    expect(monthlyView(members, accounts, [st, book], { period: "2024-25" }).months.map((m) => m.month)).toEqual(["2024-06"]);
    // a calendar-year statement whose trades all fall in one financial year takes that year's label
    const oneYear: ImportRecord = { ...book, fills: book.fills.slice(2) };
    expect(summarize(members, accounts, [stmt(1, 10, -1000, 100, "2024-01-01", "2024-12-31"), oneYear]).byPeriod.map((p) => [p.key, p.realized])).toEqual([["2024-25", -1000]]);
    // no tradebook: the statement is not guessed at, it keeps its own period
    expect(summarize(members, accounts, [st]).byPeriod.map((p) => p.key)).toEqual(["2024-01-01 to 2024-12-31"]);
    // a tradebook that does not add up to the statement is not trusted to cut it either
    const odd = stmt(2, 10, -700, 100, "2024-01-01", "2024-12-31");
    expect(summarize(members, accounts, [odd, book]).byPeriod).toHaveLength(1);
  });
  test("the month view takes realised from dated fills and spreads the charges by traded value", () => {
    const book: ImportRecord = { ...stmt(3, 10, 0, 0), kind: "tradebook", lines: [], charges: [], fills: [
      { symbol: "NIFTY2462023600CE", date: "2024-06-20", time: null, side: "buy", quantity: 25, price: 40, tradeId: "a", exchange: "NSE" },
      { symbol: "NIFTY2462023600CE", date: "2024-06-20", time: null, side: "sell", quantity: 25, price: 50, tradeId: "b", exchange: "NSE" },
      { symbol: "NIFTY2462023600CE", date: "2024-07-02", time: null, side: "buy", quantity: 25, price: 100, tradeId: "c", exchange: "NSE" },
      { symbol: "NIFTY2462023600CE", date: "2024-07-02", time: null, side: "sell", quantity: 25, price: 60, tradeId: "d", exchange: "NSE" },
    ] };
    const st = stmt(1, 10, -750, 100);
    st.lines[0].realized = -750; // +250 in June, -1000 in July
    const v = monthlyView(members, accounts, [st, book]);
    expect(v.months.map((m) => [m.month, m.realized])).toEqual([["2024-06", 250], ["2024-07", -1000]]);
    expect(v.months.reduce((a, m) => a + m.charges, 0)).toBeCloseTo(100, 1);
    expect(v.reconciliation[0].ok).toBe(true);
    expect(v.withoutTradebook).toEqual([]);
    expect(monthlyView(members, accounts, [st]).withoutTradebook).toHaveLength(1);
  });
});

describe("months for statements without dates", () => {
  const members: FamilyMember[] = [{ id: 1, nickname: "A", relation: "", hidden: false, note: "" }];
  const accounts: FamilyAccount[] = [{ id: 10, memberId: 1, broker: "kotak", label: "k", clientCode: "XYZ123" }, { id: 11, memberId: 1, broker: "zerodha", label: "z", clientCode: "AB1234" }];
  const line = (symbol: string, realized: number, charges?: number) => ({ symbol, quantity: 25, buyValue: 1000, sellValue: 1000 + realized, realized, openQuantity: 0, unrealized: 0, ...(charges !== undefined ? { charges } : {}) });
  const stmt = (id: number, accountId: number, lines: ReturnType<typeof line>[], charge: number, over: Partial<ImportRecord> = {}): ImportRecord => ({
    id, accountId, kind: "pnl", segment: "fno", periodFrom: "2024-04-01", periodTo: "2025-03-31", fileName: `s${id}.xlsx`, importedAt: "", summary: { charges: charge, otherCreditDebit: 0, realized: lines.reduce((a, l) => a + l.realized, 0), unrealized: 0 },
    lines, charges: [{ head: "Brokerage", amount: charge }], fills: [], problems: [], ...over,
  });

  test("each contract goes in the month it expires, with its own charges or its share of the statement's, and the months add up to the net", () => {
    const k = stmt(1, 10, [line("NIFTY 24DEC24 CE 24000", 500, 20), line("NIFTY 24NOV24 CE 24000", -200, 10), line("SENSEX 26DEC24 PE 80000", -100, 5)], 35);
    const v = monthlyView(members, accounts, [k]);
    expect(v.months.map((m) => [m.month, m.est.realized, m.est.charges, m.est.contracts, m.net])).toEqual([["2024-11", -200, 10, 1, -210], ["2024-12", 400, 25, 2, 375]]);
    expect(v.months.reduce((a, m) => a + m.net, 0)).toBeCloseTo(summarize(members, accounts, [k]).totals.net, 6);
    expect(v.months.every((m) => m.realized === 0 && m.closes === 0)).toBe(true); // nothing here is exact
    expect(v.unplaced).toEqual({ contracts: 0, realized: 0 });
  });

  test("a statement with no per-contract charges shares its total by traded value", () => {
    const z = stmt(2, 11, [line("NIFTY2461923000CE", 100), line("NIFTY24JUL23000CE", -100)], 20);
    const v = monthlyView(members, accounts, [z]);
    expect(v.months.map((m) => [m.month, m.est.charges])).toEqual([["2024-06", 10.5], ["2024-07", 9.5]]); // weights 2,100 and 1,900 of 4,000 traded
  });

  test("a contract cannot be placed after its statement ends or after the statement was imported", () => {
    const k = stmt(1, 10, [line("NIFTY 26DEC26 CE 24000", 500, 20)], 20, { periodTo: "2027-03-31", importedAt: "2026-10-28T04:00:00Z" });
    expect(monthlyView(members, accounts, [k]).months.map((m) => m.month)).toEqual(["2026-10"]);
    const short = stmt(1, 10, [line("NIFTY 26DEC24 CE 24000", 500, 20)], 20, { periodTo: "2024-10-31" });
    expect(monthlyView(members, accounts, [short]).months.map((m) => m.month)).toEqual(["2024-10"]);
  });

  test("a name with no expiry is counted as unplaced, never dropped from the total", () => {
    const v = monthlyView(members, accounts, [stmt(3, 11, [line("RELIANCE", 300, 5), line("NIFTY24JUL23000CE", 50, 5)], 10)]);
    expect(v.unplaced).toEqual({ contracts: 1, realized: 300 });
    expect(v.months.map((m) => m.month)).toEqual(["2024-07"]);
  });

  test("the year filter keeps only the months in that financial year", () => {
    const k = stmt(1, 10, [line("NIFTY 24DEC24 CE 24000", 500, 20), line("NIFTY 25MAY25 CE 24000", 100, 5)], 25, { periodTo: "2026-03-31" });
    expect(monthlyView(members, accounts, [k], { period: "2024-25" }).months.map((m) => m.month)).toEqual(["2024-12"]);
    expect(monthlyView(members, accounts, [k], { period: "2025-26" }).months.map((m) => m.month)).toEqual(["2025-05"]);
  });

  test("exact months stay exact, and the symbols a tradebook does not hold are placed by expiry", () => {
    const fill = (symbol: string, date: string, side: "buy" | "sell", price: number, id: string) => ({ symbol, date, time: null, side, quantity: 25, price, tradeId: id, exchange: "NSE" }) as const;
    const book: ImportRecord = { ...stmt(4, 11, [], 0), kind: "tradebook", fills: [fill("NIFTY2461923000CE", "2024-06-19", "buy", 40, "a"), fill("NIFTY2461923000CE", "2024-06-19", "sell", 50, "b")] };
    // the statement also holds a position the tradebook never saw (opened before it starts)
    const st = stmt(5, 11, [line("NIFTY2461923000CE", 250), line("NIFTY24JUL23900PE", -2731.25)], 30);
    const v = monthlyView(members, accounts, [st, book]);
    expect(v.reconciliation[0].ok).toBe(false);
    const june = v.months.find((m) => m.month === "2024-06")!;
    const july = v.months.find((m) => m.month === "2024-07")!;
    expect(june).toMatchObject({ realized: 250, closes: 1 });
    expect(june.est.contracts).toBe(0);
    expect(july).toMatchObject({ realized: 0, closes: 0 });
    expect(july.est).toMatchObject({ realized: -2731.25, contracts: 1 });
    expect(v.months.reduce((a, m) => a + m.realized + m.est.realized, 0)).toBeCloseTo(250 - 2731.25, 6);
  });
});
