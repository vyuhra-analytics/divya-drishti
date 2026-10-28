import { describe, expect, test } from "bun:test";
import { selectParts, summarize, type FamilyAccount, type FamilyMember, type ImportRecord } from "./family";
import { accountantStatement, contractRows, insights, memberByYear, statementCoverage, statementHtml, statementRows, yearBySegment } from "./familyInsights";
import type { PnlLine, Segment } from "./zerodhaPnl";

const members: FamilyMember[] = [{ id: 1, nickname: "Dad", relation: "", hidden: false, note: "" }, { id: 2, nickname: "Sis <b>", relation: "", hidden: false, note: "" }];
const accounts: FamilyAccount[] = [{ id: 10, memberId: 1, broker: "zerodha", label: "Zerodha account", clientCode: "AB1234" }, { id: 20, memberId: 2, broker: "kotak", label: "Kotak account", clientCode: "XYZ789" }];
const line = (symbol: string, realized: number, charges?: number): PnlLine => ({ symbol, quantity: 25, buyValue: 0, sellValue: realized, realized, openQuantity: 0, unrealized: 0, ...(charges !== undefined ? { charges } : {}) });
const stmt = (id: number, accountId: number, segment: Segment, from: string, to: string, lines: PnlLine[], charge: number, fileName = `s${id}.xlsx`): ImportRecord => ({
  id, accountId, kind: "pnl", segment, periodFrom: from, periodTo: to, fileName, importedAt: "",
  summary: { charges: charge, otherCreditDebit: 0, realized: lines.reduce((a, l) => a + l.realized, 0), unrealized: 0 },
  lines, charges: [{ head: "Brokerage - Z", amount: charge * 0.6 }, { head: "GST", amount: charge * 0.4 }], fills: [], problems: [],
});

// Dad (Zerodha, no per-contract charges): FY 2024-25 F&O, three contracts. Sis (Kotak, per-contract charges): FY 2024-25 F&O and commodity, 2025-26 F&O.
const imports: ImportRecord[] = [
  stmt(1, 10, "fno", "2024-04-01", "2025-03-31", [line("NIFTY24JUN23000CE", 1000), line("NIFTY24JUN23100PE", -3000), line("BANKNIFTY24JUN50000CE", -2000)], 100),
  stmt(2, 20, "fno", "2024-04-01", "2025-03-31", [line("NIFTY 24DEC24 CE 24000", 500, 20), line("SENSEX 24DEC24 PE 80000", -1500, 30)], 50),
  stmt(3, 20, "commodity", "2024-04-01", "2025-03-31", [line("CRUDEOIL 15NOV24 CE 5900", 2500, 40), line("NATURALGAS 21NOV24 PE 220", -500, 10)], 50),
  stmt(4, 20, "fno", "2025-04-01", "2026-03-31", [line("NIFTY 25DEC25 CE 26000", 800, 15)], 15),
];

describe("contracts as rows", () => {
  test("every line of a selection is a row with its underlying, segment, year and the charges only when the statement gives them", () => {
    const rows = contractRows(selectParts(accounts, imports));
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.id)).size).toBe(8);
    const zerodha = rows.find((r) => r.symbol === "NIFTY24JUN23000CE")!;
    expect(zerodha).toMatchObject({ underlying: "NIFTY", segment: "fno", fy: "2024-25", memberId: 1, realized: 1000 });
    expect(zerodha.charges).toBeUndefined();
    expect(rows.find((r) => r.symbol === "CRUDEOIL 15NOV24 CE 5900")).toMatchObject({ segment: "commodity", charges: 40, net: 2460, underlying: "CRUDEOIL" });
  });
});

describe("insights", () => {
  const parts = selectParts(accounts, imports, { period: "2024-25" });
  const ins = insights(contractRows(parts), parts)!;
  test("counts, averages and the size of wins against losses", () => {
    // wins: 1000, 500, 2500 (3); losses: -3000, -2000, -1500, -500 (4)
    expect(ins).toMatchObject({ contracts: 7, winners: 3, losers: 4, grossProfit: 4000, grossLoss: -7000, expectancy: -428.57 });
    expect(ins.winRate).toBeCloseTo(3 / 7, 6);
    expect(ins.avgWin).toBeCloseTo(1333.33, 2);
    expect(ins.avgLoss).toBe(-1750);
    expect(ins.payoff).toBe(0.76);
    expect(ins.profitFactor).toBe(0.57);
    expect(ins.charges).toBe(200);
    expect(ins.chargesOfWinnings).toBeCloseTo(0.05, 6);
  });
  test("the worst and best contracts and how much of the losses the worst five hold", () => {
    expect(ins.worst.map((r) => r.symbol)).toEqual(["NIFTY24JUN23100PE", "BANKNIFTY24JUN50000CE", "SENSEX 24DEC24 PE 80000", "NATURALGAS 21NOV24 PE 220"]);
    expect(ins.best[0].symbol).toBe("CRUDEOIL 15NOV24 CE 5900");
    expect(ins.worstFiveShare).toBe(1); // only four losing contracts, so they are all of the losses
  });
  test("a segment is read on its own", () => {
    const fno = ins.bySegment.find((s) => s.segment === "fno")!;
    const com = ins.bySegment.find((s) => s.segment === "commodity")!;
    expect(fno).toMatchObject({ contracts: 5, realized: -5000 });
    expect(com).toMatchObject({ contracts: 2, realized: 2000, winRate: 0.5 });
    expect(com.payoff).toBe(5);
  });
  test("a plain sentence, and nothing when no contract has a result", () => {
    expect(ins.verdict).toMatch(/43% of contracts closed in profit and the average win is 0.76 times the average loss/);
    expect(insights([], [])).toBeUndefined();
    expect(insights(contractRows(selectParts(accounts, [stmt(9, 10, "fno", "2024-04-01", "2025-03-31", [line("NIFTY24JUN23000CE", 0)], 5)])), [])).toBeUndefined();
    const lucky = selectParts(accounts, [stmt(9, 10, "fno", "2024-04-01", "2025-03-31", [line("NIFTY24JUN23000CE", 100), line("NIFTY24JUN23100PE", -50)], 5)]);
    expect(insights(contractRows(lucky), lucky)!.verdict).toMatch(/wins outweigh the losses/);
    const bad = selectParts(accounts, [stmt(9, 10, "fno", "2024-04-01", "2025-03-31", [line("NIFTY24JUN23000CE", 100), line("NIFTY24JUN23100PE", -900), line("NIFTY24JUN23200PE", -100)], 5)]);
    expect(insights(contractRows(bad), bad)!.verdict).toMatch(/33% of contracts closed in profit/);
  });
  test("a winning share over half with a net loss is named for what it is: the average loss against the average win", () => {
    const p = selectParts(accounts, [stmt(9, 10, "fno", "2024-04-01", "2025-03-31", [line("NIFTY24JUN23000CE", 100), line("NIFTY24JUN23100PE", 100), line("NIFTY24JUN23200PE", -1000)], 5)]);
    expect(insights(contractRows(p), p)!.verdict).toBe("67% of contracts closed in profit, but the average loss is 10.0 times the average win, so the result is negative.");
  });
});

describe("cross-tabs", () => {
  const parts = selectParts(accounts, imports);
  test("year by segment puts each statement in one cell and the cells add up to the totals", () => {
    const t = yearBySegment(parts);
    expect(t.rows.map((r) => r.key)).toEqual(["2024-25", "2025-26"]);
    expect(t.cols.map((c) => c.key)).toEqual(["commodity", "fno"]);
    expect(t.cells["2024-25"].fno).toMatchObject({ realized: -5000, charges: 150, net: -5150 });
    expect(t.cells["2024-25"].commodity).toMatchObject({ realized: 2000, charges: 50 });
    expect(t.cells["2025-26"].commodity).toBeUndefined();
    const all = Object.values(t.cells).flatMap((r) => Object.values(r));
    expect(all.reduce((a, c) => a + c.net, 0)).toBeCloseTo(summarize(members, accounts, imports).totals.net, 6);
  });
  test("member by year", () => {
    const t = memberByYear(parts, members);
    expect(t.rows.map((r) => r.label)).toEqual(["Dad", "Sis <b>"]);
    expect(t.cells["1"]["2024-25"].net).toBe(-4100);
    expect(t.cells["2"]["2025-26"].realized).toBe(800);
  });
});

describe("underlying charges across brokers", () => {
  test("an underlying keeps the charges the statements give and says whether they are all of its contracts", () => {
    const mixed = [...imports, stmt(5, 10, "fno", "2025-04-01", "2026-03-31", [line("NIFTY25DEC26000CE", 100)], 10)];
    const s = summarize(members, accounts, mixed);
    expect(s.underlyingHasCharges).toBe(true);
    const nifty = s.byUnderlying.find((u) => u.key === "NIFTY")!;
    expect(nifty.chargesComplete).toBe(false); // Zerodha NIFTY contracts carry no per-contract charges
    expect(nifty.charges).toBe(35); // what Kotak gave: 20 + 15
    const crude = s.byUnderlying.find((u) => u.key === "CRUDEOIL")!;
    expect(crude).toMatchObject({ chargesComplete: true, charges: 40, net: 2460 });
    const zerodhaOnly = summarize(members, accounts, [imports[0]]);
    expect(zerodhaOnly.underlyingHasCharges).toBe(false);
    expect(zerodhaOnly.byUnderlying.every((u) => !u.chargesComplete)).toBe(true);
  });
});

describe("coverage", () => {
  test("which statements and tradebooks are loaded for each account and year, and which cover only part of a year", () => {
    const book: ImportRecord = { ...stmt(6, 10, "fno", "2024-06-01", "2024-07-31", [], 0), kind: "tradebook" };
    const v = statementCoverage(accounts, [...imports, book]);
    expect(v.years).toEqual(["2024-25", "2025-26"]);
    const dad = v.rows.find((r) => r.accountId === 10)!;
    expect(dad.cells["2024-25"]).toMatchObject({ statements: ["fno"], tradebook: true, partial: false });
    expect(dad.cells["2025-26"]).toBeUndefined();
    const sis = v.rows.find((r) => r.accountId === 20)!;
    expect(sis.cells["2024-25"].statements.sort()).toEqual(["commodity", "fno"]);
    expect(sis.cells["2024-25"].tradebook).toBe(false);
    // a statement for part of a year is marked partial
    const part = statementCoverage(accounts, [stmt(7, 10, "fno", "2024-04-01", "2024-10-28", [line("NIFTY24JUN23000CE", 1)], 1)]);
    expect(part.rows.find((r) => r.accountId === 10)!.cells["2024-25"].partial).toBe(true);
    // a calendar-year statement touches two financial years
    const cal = statementCoverage(accounts, [stmt(8, 10, "fno", "2024-01-01", "2024-12-31", [line("NIFTY24JUN23000CE", 1)], 1)]);
    expect(cal.years).toEqual(["2023-24", "2024-25"]);
  });
});

describe("the accountant's statement", () => {
  const st = accountantStatement(members, accounts, imports, 2, "2024-25")!;
  test("per segment: realised, charges by head and net, and the totals add up", () => {
    expect(st.segments.map((s) => [s.segment, s.realized, s.chargesTotal, s.net])).toEqual([["commodity", 2000, 50, 1950], ["fno", -1000, 50, -1050]]);
    expect(st.totals).toMatchObject({ contracts: 4, realized: 1000, chargesTotal: 100, net: 900, turnoverAtLeast: 5000 });
    expect(st.segments[0].charges.map((c) => c.group).sort()).toEqual(["Brokerage", "GST"]);
    expect(st.accounts[0]).toMatchObject({ broker: "Kotak", client: "***789" });
    expect(st.contracts).toHaveLength(4);
  });
  test("nothing for a member or year with no statements", () => {
    expect(accountantStatement(members, accounts, imports, 1, "2025-26")).toBeUndefined();
    expect(accountantStatement(members, accounts, imports, 99, "2024-25")).toBeUndefined();
  });
  test("a statement that could not be cut to financial years is exported under its own period and says so", () => {
    const wide = accountantStatement(members, accounts, [stmt(9, 10, "fno", "2024-01-01", "2024-12-31", [line("NIFTY24JUN23000CE", 100)], 5, "wide.xlsx")], 1, "2024-01-01 to 2024-12-31");
    expect(wide).toMatchObject({ notCut: true, fy: "2024-01-01 to 2024-12-31", totals: { realized: 100 } });
    expect(statementHtml(wide!, "Dad")).toContain("not cut into financial years");
    expect(JSON.stringify(statementRows(wide!, "Dad"))).toContain("not cut into financial years");
    expect(st.notCut).toBe(false);
  });
  test("the page escapes everything typed and never prints a client id in full", () => {
    const html = statementHtml(st, "Sis <b>");
    expect(html).toContain("Sis &lt;b&gt;");
    expect(html).not.toContain("<b>Sis");
    expect(html).toContain("***789");
    expect(html).not.toContain("XYZ789");
    expect(html).toContain("not tax advice");
    expect(html).toContain("Net after charges");
  });
  test("the CSV rows carry the same figures and a note, and no client id", () => {
    const rows = statementRows(st, "Sis");
    const flat = JSON.stringify(rows);
    expect(flat).toContain("***789");
    expect(flat).not.toContain("XYZ789");
    expect(rows.find((r) => r[0] === "Total")).toEqual(["Total", 4, "", "", 1000, 100, 900, 5000]);
    expect(flat).toContain("not tax advice");
  });
});
