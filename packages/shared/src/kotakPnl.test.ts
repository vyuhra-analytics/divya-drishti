import { describe, expect, test } from "bun:test";
import { looksLikeKotakPnl, parseKotakPnl, parseKotakSections } from "./kotakPnl";
import { chargeGroup, parseSymbol, summarize, type ImportRecord } from "./family";
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

describe("Kotak's newer layout (2026-27): buy and sell charge columns", () => {
  // charges per side: buy GST 2, brokerage 10, misc 3, STT 6 (total 21); sell 2, 10, 2, 4 (total 18); realised -4398.14 after 29 of non-STT charges -> gross -4369.14,
  // net = gross - 39 = -4408.14
  const bytes = () =>
    makeXlsx([
      {
        name: "Realized Gain-Loss",
        rows: [
          [],
          ["Client Name"],
          ["Client Code", "XYZ123", null, "Charges", null, 39],
          ["Transaction Period", "From : 2026-04-01 To : 2027-03-31", null, "Net P&L", null, -4408.14],
          ["Transaction Type", "ALL", null, "Segment Type", null, "Derivatives"],
          [],
          [],
          ["Script Name", "Security Type", "ISIN", "Qty", "Buy Amt. (A)", "Sell Amt. (B)", "Gross Realized P&L", null, null, null, "Charges", null, null, null, null, null, null, null, null, null, null, "Net P&L (T - S)", "Gross P&L (T + (C + D + E))"],
          [null, null, null, null, null, null, "Intraday", "<1yr.", ">1Yr.", "Total\n(T = B - A)", "Buy GST (C)", "Buy Brokerage (D)", "Buy Misc. (E)", "Buy STT/CTT (S)", "Buy Total", "Sell GST (C)", "Sell Brokerage (D)", "Sell Misc. (E)", "Sell STT/CTT (S)", "Sell Total", "Total Charges", null, null],
          ["Derivatives"],
          ["SENSEX 04Jun26 CE 76200", "IO", "-", 20, 12000, 7601.86, "-", -4398.14, "NA", -4398.14, 2, 10, 3, 6, 21, 2, 10, 2, 4, 18, 39, -4408.14, -4369.14],
          ["Derivatives Total", "", "", 20, 12000, 7601.86, 0, -4398.14, 0, -4398.14, 2, 10, 3, 6, 21, 2, 10, 2, 4, 18, 39, -4408.14, -4369.14],
        ] as never,
      },
    ]);

  test("heads are summed over both sides, the total is 'Total Charges', and the figures reconcile", async () => {
    const p = parseKotakPnl(await readXlsx(bytes()));
    expect(p.problems).toEqual([]);
    expect(p.lines[0]).toMatchObject({ symbol: "SENSEX 04Jun26 CE 76200", realized: -4369.14, charges: 39 });
    expect(Object.fromEntries(p.charges.map((c) => [c.head.split(" ")[0], c.amount]))).toMatchObject({ Brokerage: 20, GST: 4, Miscellaneous: 5, Securities: 10 });
    expect(p.summary.realized - p.summary.charges).toBeCloseTo(-4408.14, 6);
    expect(parseSymbol(p.lines[0].symbol)).toMatchObject({ underlying: "SENSEX", kind: "option", optionType: "CE", strike: 76200 });
  });
});

describe("Kotak's all-segment report", () => {
  const head = [
    [],
    ["Client Name"],
    ["Client Code", "XYZ123", null, "Charges", null, 78],
    ["Transaction Period", "From : 2024-04-01 To : 2025-03-31", null, "Net P&L", null, 12],
    ["Transaction Type", "ALL", null, "Segment Type", null, "Derivatives, Commodity, Mutual Funds"],
    [],
    [],
    ["Script Name", "Security Type", "ISIN", "Qty", "Buy Amt. (A)", "Sell Amt. (B)", "Gross Realized P&L", null, null, null, "Charges", null, null, null, null, "Net P&L (T - S)", "Gross P&L (T + (C + D + E))"],
    [null, null, null, null, null, null, "Intraday", "<1yr.", ">1Yr.", "Total (T = B - A)", "GST (C)", "Brokerage (D)", "Misc. (E)", "STT/CTT (S)", "Total (C + D + E + S)", null, null],
  ];
  // derivatives: gross 127.77, charges 33.25 (net 94.52); commodity: gross 100, charges 44.75 (net 55.25); file: charges 78, net 149.77 - 78 = ... the header is built from these
  const deriv = ["BANKNIFTY 24DEC24 CE 52700", "OPTIDX", "-", 15, 1000, 1100, "-", 100, "NA", 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77];
  const comm = ["CRUDEOIL 15NOV24 CE 5900", "OPTFUT", "-", 100, 12000, 12060, "-", 60, "NA", 60, 4, 20, 10, 10.75, 44.75, 49.25, 94];
  const book = (header: unknown[][] = head) =>
    makeXlsx([
      {
        name: "Realized Gain-Loss",
        rows: [
          ...header,
          ["Derivatives"],
          deriv,
          ["Derivatives Total", "", "", 15, 1000, 1100, 0, 100, 0, 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77],
          ["Commodity"],
          comm,
          ["Commodity Total", "", "", 100, 12000, 12060, 0, 60, 0, 60, 4, 20, 10, 10.75, 44.75, 49.25, 94],
          [],
          ["Grand Total", "", "", 115, 13000, 13160, 0, 160, 0, 160, 7.6, 40, 14.17, 16.23, 78, 143.77, 221.77],
          [],
          ["Disclaimer"],
        ] as never,
      },
    ]);
  const fixHeader = () => head.map((r, i) => (i === 3 ? ["Transaction Period", "From : 2024-04-01 To : 2025-03-31", null, "Net P&L", null, 143.77] : i === 2 ? ["Client Code", "XYZ123", null, "Charges", null, 78] : r));

  test("each section is a statement of its own segment, reconciled on its own, and together they match the file's header", async () => {
    const parts = parseKotakSections(await readXlsx(book(fixHeader())));
    expect(parts.map((p) => [p.segment, p.lines.length, p.summary.realized, p.summary.charges])).toEqual([["fno", 1, 127.77, 33.25], ["commodity", 1, 94, 44.75]]);
    expect(parts.flatMap((p) => p.problems)).toEqual([]);
    expect(parts[1].lines[0].symbol).toBe("CRUDEOIL 15NOV24 CE 5900");
    expect(parseSymbol(parts[1].lines[0].symbol).underlying).toBe("CRUDEOIL");
    // the single-statement reader refuses a file with several segments rather than silently dropping one
    expect(() => parseKotakPnl(parts as never)).toThrow();
  });

  test("a section total that disagrees with its contracts is a problem naming the section", async () => {
    const bytes = makeXlsx([{ name: "Realized Gain-Loss", rows: [...fixHeader(), ["Derivatives"], deriv, ["Derivatives Total", "", "", 15, 1000, 1100, 0, 100, 0, 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 999], ["Disclaimer"]] as never }]);
    expect((await Promise.resolve(parseKotakSections(await readXlsx(bytes))))[0].problems.join(" ")).toMatch(/Derivatives.*total row says 999/);
  });

  test("a section that is not supported (mutual funds) is refused in words", async () => {
    const bytes = makeXlsx([{ name: "Realized Gain-Loss", rows: [...fixHeader(), ["Mutual Funds"], deriv, ["Mutual Funds Total"], ["Disclaimer"]] as never }]);
    await expect(readXlsx(bytes).then(parseKotakSections)).rejects.toThrow(/"Mutual Funds" section, which is not supported/);
  });
});

test("Kotak's lumped miscellaneous head is its own group, not filed under one of the charges it contains", () => {
  expect(chargeGroup("Miscellaneous charges (exchange, clearing, stamp, SEBI)")).toBe("Miscellaneous");
  expect(chargeGroup("Securities transaction tax / CTT")).toBe("STT / CTT");
  expect(chargeGroup("Clearing Charges - Z")).toBe("Clearing");
  expect(chargeGroup("Exchange Transaction Charges - Z")).toBe("Exchange");
});
