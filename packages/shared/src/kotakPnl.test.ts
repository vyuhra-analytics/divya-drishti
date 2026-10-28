import { describe, expect, test } from "bun:test";
import { looksLikeKotakPnl, parseKotakPnl } from "./kotakPnl";
import { parseSymbol, summarize, type ImportRecord } from "./family";
import { readXlsx } from "./xlsx";
import { makeXlsx } from "./xlsxTestUtil";

// A small Kotak Neo "Realized Gain-Loss" workbook in the layout of the real file (verified on a 147-contract statement). Built here, so no real statement is
// committed. The figures follow Kotak's own arithmetic: the realised column is after brokerage, GST and misc (STT comes off later), the gross column is before
// them, and gross less ALL charges is the net.
const header = [
  "Script Name", "Security Type", "ISIN", "Qty", "Buy Amt. (A)", "Sell Amt. (B)", "Gross Realized P&L\n(Including all charges Excluding STT)", null, null, null, "Charges", null, null, null, null,
  "Net P&L (T - S)\n(Including All charges)", "Gross P&L (T + (C + D + E))\n(Excluding All Charges)",
];
const sub = [null, null, null, null, null, null, "Intraday", "<1yr.", ">1Yr.", "Total\n(T = B - A)", "GST (C)", "Brokerage (D)", "Misc. (E)", "STT/CTT (S)", "Total (C + D + E + S)", null, null];
// BANKNIFTY call: realised 100 after 27.77 of non-STT charges, 5.48 STT; gross = 100 + 27.77 = 127.77; net = 127.77 - 33.25 = 94.52
const row1 = ["BANKNIFTY 24DEC24 CE 52700", "OPTIDX", "-", 15, 1000, 1100, "-", 100, "NA", 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77];
// a stock option: realised -50 after 10 of non-STT charges, 2 STT; gross -40; net -40 - 12 = -52
const row2 = ["CHOLAFIN 26DEC24 CE 1320", "OPTSTK", "-", 625, 2000, 1950, "-", -50, "NA", -50, 1.8, 8, 0.2, 2, 12, -52, -40];
const total = ["Derivatives Total", "", "", 640, 3000, 3050, 0, 50, 0, 50, 5.4, 28, 4.37, 7.48, 45.25, 42.52, 87.77];

function workbook(over: { client?: string; netHeader?: number; extraRows?: unknown[][] } = {}) {
  return makeXlsx([
    {
      name: "Realized Gain-Loss",
      rows: [
        [],
        ["Client Name", null, null, "Realised P&L", null, 50, null, "Equity Delivery Turnover", null, 0],
        ["Client Code", over.client ?? "XYZ123", null, "Charges", null, 45.25, null, "Equity Intraday Turnover", null, 0],
        ["Transaction Period", "From : 2024-04-01 To : 2025-03-31", null, "Net P&L", null, over.netHeader ?? 42.52, null, "Bonds Delivery Turnover", null, 0],
        ["Transaction Type", "ALL", null, "Segment Type", null, "Derivatives", null, "Futures Turnover", null, 0],
        [],
        [],
        header,
        sub,
        ["Derivatives"],
        row1,
        row2,
        ...(over.extraRows ?? []),
        total,
        [],
        ["Disclaimer"],
      ] as never,
    },
    { name: "P&L Equity-Tradewise", rows: [["Client Name"]] },
  ]);
}

describe("Kotak Neo Gain-Loss statement", () => {
  test("is recognised, and read with the gross result, per-contract charges and a clean reconciliation", async () => {
    const sheets = await readXlsx(workbook());
    expect(looksLikeKotakPnl(sheets)).toBe(true);
    const p = parseKotakPnl(sheets);
    expect(p).toMatchObject({ broker: "kotak", segment: "fno", periodFrom: "2024-04-01", periodTo: "2025-03-31", clientCode: "XYZ123" });
    expect(p.problems).toEqual([]);
    expect(p.lines.map((l) => [l.symbol, l.realized, l.charges])).toEqual([["BANKNIFTY 24DEC24 CE 52700", 127.77, 33.25], ["CHOLAFIN 26DEC24 CE 1320", -40, 12]]);
    // gross less all charges is Kotak's own net, so nothing is counted twice
    expect(p.summary).toMatchObject({ realized: 87.77, charges: 45.25 });
    expect(p.summary.realized - p.summary.charges).toBeCloseTo(42.52, 6);
    expect(p.charges.find((c) => c.head === "Brokerage")?.amount).toBe(28);
    expect(p.charges.reduce((a, c) => a + c.amount, 0)).toBeCloseTo(45.25, 6);
  });

  test("a Zerodha statement is not mistaken for one, and a statement that does not add up says so", async () => {
    expect(looksLikeKotakPnl(await readXlsx(makeXlsx([{ name: "F&O", rows: [[null, "P&L Statement for F&O from 2024-04-01 to 2024-10-28"]] }])))).toBe(false);
    const wrongNet = parseKotakPnl(await readXlsx(workbook({ netHeader: 999 })));
    expect(wrongNet.problems.join(" ")).toMatch(/summary's net is 999/);
    const broken = ["BAD 24DEC24 CE 1", "OPTIDX", "-", 1, 10, 20, "-", 10, "NA", 10, 0, 0, 0, 0, 0, 12, 10]; // net says 12, gross less charges is 10
    expect(parseKotakPnl(await readXlsx(workbook({ extraRows: [broken] }))).problems.join(" ")).toMatch(/BAD 24DEC24 CE 1/);
  });

  test("an unsupported segment is refused in words rather than read wrongly", async () => {
    const bytes = makeXlsx([{ name: "Realized Gain-Loss", rows: [[], ["Client Code", "ABC123"], ["Transaction Period", "From : 2024-04-01 To : 2025-03-31"], ["Segment Type", null, "Mutual Funds"], [], [], [], ["Script Name"], []] as never }]);
    expect(() => parseKotakPnl([{ name: "Realized Gain-Loss", rows: [[], ["Client Code", "ABC123"], ["Transaction Period", "From : 2024-04-01 To : 2025-03-31"], ["Segment Type", null, "Mutual Funds"], ["Script Name"]] as never }])).toThrow(/not supported/);
    void bytes;
  });

  test("Kotak's contract names give their underlying, and the statement splits charges by underlying (Zerodha's cannot)", async () => {
    expect(parseSymbol("BANKNIFTY      24DEC24    CE 52700")).toEqual({ underlying: "BANKNIFTY", kind: "option", optionType: "CE", strike: 52700 });
    expect(parseSymbol("M&M 26DEC24 PE 2900.5")).toMatchObject({ underlying: "M&M", strike: 2900.5 });
    expect(parseSymbol("NIFTY 26DEC24 FUT")).toEqual({ underlying: "NIFTY", kind: "future" });
    const p = parseKotakPnl(await readXlsx(workbook()));
    const imp: ImportRecord = { id: 1, accountId: 1, kind: "pnl", segment: p.segment, periodFrom: p.periodFrom, periodTo: p.periodTo, fileName: "k.xlsx", importedAt: "", summary: p.summary, lines: p.lines, charges: p.charges, fills: [], problems: [] };
    const s = summarize([{ id: 1, nickname: "A", relation: "", hidden: false, note: "" }], [{ id: 1, memberId: 1, broker: "kotak", label: "x", clientCode: "XYZ123" }], [imp]);
    expect(s.underlyingHasCharges).toBe(true);
    expect(s.byUnderlying.map((u) => [u.label, u.charges, u.net])).toEqual(expect.arrayContaining([["BANKNIFTY", 33.25, 94.52], ["CHOLAFIN", 12, -52]]));
    expect(s.totals.net).toBeCloseTo(42.52, 6);
  });
});
