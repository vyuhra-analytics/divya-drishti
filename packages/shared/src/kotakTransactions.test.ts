import { describe, expect, test } from "bun:test";
import { kotakContractName, looksLikeKotakTransactions, parseKotakTransactions } from "./kotakTransactions";
import { monthlyView, type FamilyAccount, type FamilyMember, type ImportRecord } from "./family";
import { parseKotakSections } from "./kotakPnl";
import { readXlsx } from "./xlsx";
import { makeXlsx } from "./xlsxTestUtil";

// Kotak's "Transaction Statement" (its tradebook) in the layout of the real file (two years, about 660 fills, verified), built here so no real statement is committed.
const HEAD = ["Trade Date", "Trade Time", "Order Time", "Security Name", "ISIN", "Exchange", "Order Source", "Transaction Type", "Product Type", "Quantity", "Market Rate", "Total", "GST", "Brokerage", "Misc.", "Total Charges", "STT/CTT"];
// date, time, name, exchange, side, qty, rate, gst, brokerage, misc, stt  (Total Charges = gst + brokerage + misc)
const fill = (d: string, t: string, name: string, exch: string, side: string, q: number, rate: number, gst: number, brk: number, misc: number, stt: number) => [d, t, t, name, "-", exch, "Kotak Neo", side, "Cash", q, rate, q * rate, gst, brk, misc, Math.round((gst + brk + misc) * 100) / 100, stt];
const NIFTY = "OPTIDXNIFTY     21AUG2025PE  24750.00";
const CRUDE = "OPTFUTCRUDEOIL  17FEB2025PE   6350.00";
const rows = [
  fill("27/01/2025", "21:02:22", CRUDE, "MCX      ", "Sell", 100, 158.2, 1.8, 10, 7.82, 7.91), // newest first, as the file has them
  fill("27/01/2025", "17:55:00", CRUDE, "MCX      ", "Buy", 100, 150, 1.8, 10, 7.87, 0),
  fill("19/08/2025", "12:55:25", NIFTY, "NSEDERV  ", "Buy", 75, 16.5, 1.88, 10, 0.44, 0), // bought and never sold: expires worthless
];
const sheet = (data: unknown[][], over: { buy?: string; sell?: string; charges?: string; stt?: string; period?: string } = {}) => ({
  name: "On Market",
  rows: [
    [],
    ["Client Name", "SOME NAME", null, "Total Buy Value", null, null, null, over.buy ?? "16,237.50"],
    ["Client Code", "XYZ123", null, "Total Sell Value", null, null, null, over.sell ?? "15,820.00"],
    ["Transaction Period", over.period ?? "From: 2024-04-01 To: 2026-03-31", null, "Charges", null, null, null, over.charges ?? "51.61"],
    [null, null, null, "STT/CTT", null, null, null, over.stt ?? "7.91"],
    ["Exchange Type", "Derivative"],
    [],
    HEAD,
    ...data,
  ] as never,
});
const book = (data = rows, over = {}) => makeXlsx([sheet(data, over)]);

describe("Kotak contract names", () => {
  test("the long form becomes the name Kotak's Gain & Loss statement uses", () => {
    expect(kotakContractName("OPTFUTCRUDEOIL  17FEB2025PE   6350.00")).toBe("CRUDEOIL 17FEB25 PE 6350");
    expect(kotakContractName("OPTIDXNIFTY     21AUG2025PE  24750.00")).toBe("NIFTY 21AUG25 PE 24750");
    expect(kotakContractName("OPTSTKMRF       30JAN2025PE 111000.00")).toBe("MRF 30JAN25 PE 111000");
    expect(kotakContractName("OPTSTKHEROMOTOCO26DEC2024CE   5100.00")).toBe("HEROMOTOCO 26DEC24 CE 5100"); // the underlying fills the width and runs into the date
    expect(kotakContractName("OPTSTKM&M       28NOV2024CE   2900.50")).toBe("M&M 28NOV24 CE 2900.5");
    expect(kotakContractName("FUTIDXNIFTY     28NOV2024")).toBe("NIFTY 28NOV24 FUT");
    expect(kotakContractName("RELIANCE")).toBeUndefined();
    expect(kotakContractName("OPTIDXNIFTY 21XYZ2025PE 24750.00")).toBeUndefined();
  });
});

describe("Kotak Transaction Statement", () => {
  test("is recognised and every fill is read with its date, time, side, rate and its own charges (STT included)", async () => {
    const sheets = await readXlsx(book());
    expect(looksLikeKotakTransactions(sheets)).toBe(true);
    const parts = parseKotakTransactions(sheets);
    expect(parts.map((p) => [p.segment, p.fills.length])).toEqual([["commodity", 2], ["fno", 1]]); // MCX is commodity, NSE derivatives are futures and options
    const c = parts[0];
    expect(c).toMatchObject({ broker: "kotak", periodFrom: "2024-04-01", periodTo: "2026-03-31", clientCode: "XYZ123", clientName: "SOME NAME" });
    expect(c.fills.map((f) => [f.date, f.time, f.side, f.symbol, f.quantity, f.price, f.charges])).toEqual([
      ["2025-01-27", "2025-01-27T17:55:00", "buy", "CRUDEOIL 17FEB25 PE 6350", 100, 150, 19.67],
      ["2025-01-27", "2025-01-27T21:02:22", "sell", "CRUDEOIL 17FEB25 PE 6350", 100, 158.2, 27.53], // 19.62 + 7.91 STT
    ]);
    expect(c.fills[0].exchange).toBe("MCX");
    expect(c.notes).toEqual([]); // the file's own totals match its fills
  });

  test("identical rows in one file get distinct ids, and the same file read twice gives the same ids", async () => {
    const twice = [rows[0], rows[0], rows[1]];
    const a = parseKotakTransactions(await readXlsx(book(twice, { buy: "15,000.00", sell: "31,640.00", charges: "99.97", stt: "15.82" })))[0];
    const b = parseKotakTransactions(await readXlsx(book(twice, { buy: "15,000.00", sell: "31,640.00", charges: "99.97", stt: "15.82" })))[0];
    expect(new Set(a.fills.map((f) => f.tradeId)).size).toBe(3);
    expect(a.fills.map((f) => f.tradeId)).toEqual(b.fills.map((f) => f.tradeId));
  });

  test("a total in the header that the fills do not add up to is a note, not a silent difference", async () => {
    const parts = parseKotakTransactions(await readXlsx(book(rows, { charges: "1,000.00" })));
    expect(parts[0].notes.join(" ")).toMatch(/charges is 1000 but its fills add up to/);
  });

  test("an exchange or a contract it does not know is refused in words", async () => {
    await expect(readXlsx(book([fill("27/01/2025", "17:55:00", CRUDE, "BSEEQ", "Buy", 1, 1, 0, 0, 0, 0)])).then(parseKotakTransactions)).rejects.toThrow(/exchange "BSEEQ" is not supported/);
    await expect(readXlsx(book([fill("27/01/2025", "17:55:00", "RELIANCE", "NSEDERV", "Buy", 1, 1, 0, 0, 0, 0)])).then(parseKotakTransactions)).rejects.toThrow(/not a derivatives contract/);
  });

  test("a Gain & Loss statement or a Zerodha file is not mistaken for one", async () => {
    expect(looksLikeKotakTransactions(await readXlsx(makeXlsx([{ name: "Realized Gain-Loss", rows: [["Script Name"]] }])))).toBe(false);
    expect(looksLikeKotakTransactions(await readXlsx(makeXlsx([{ name: "F&O", rows: [[null, "Symbol", "Trade Date"]] }])))).toBe(false);
  });
});

describe("a Kotak tradebook with its Gain & Loss statement", () => {
  const members: FamilyMember[] = [{ id: 1, nickname: "A", relation: "", hidden: false, note: "" }];
  const accounts: FamilyAccount[] = [{ id: 10, memberId: 1, broker: "kotak", label: "Kotak account", clientCode: "XYZ123" }];
  const glLine = (symbol: string, gross: number, charges: number) => ({ symbol, quantity: 100, buyValue: 0, sellValue: 0, realized: gross, openQuantity: 0, unrealized: 0, charges });
  const imp = (id: number, kind: "pnl" | "tradebook", over: Partial<ImportRecord>): ImportRecord => ({ id, accountId: 10, kind, segment: "commodity", periodFrom: "2024-04-01", periodTo: "2026-03-31", fileName: `f${id}.xlsx`, importedAt: "2026-10-28T04:00:00Z", summary: { charges: 0, otherCreditDebit: 0, realized: 0, unrealized: 0 }, lines: [], charges: [], fills: [], problems: [], ...over });

  test("the dated fills give the exact month, the charges are the fills' own, and the statement reconciles (mixed-case names included)", async () => {
    const tb = parseKotakTransactions(await readXlsx(book([rows[0], rows[1]], { buy: "15,000.00", sell: "15,820.00", charges: "39.29", stt: "7.91" })))[0];
    // gross 100 x (158.2 - 150) = 820; Kotak's own line is the gross, its name in mixed case as the real file prints it
    const st = imp(1, "pnl", { lines: [glLine("CRUDEOIL 17Feb25 PE 6350", 820, 47.2)], charges: [{ head: "Brokerage", amount: 47.2 }] });
    const book1 = imp(2, "tradebook", { fills: tb.fills });
    const v = monthlyView(members, accounts, [st, book1]);
    expect(v.reconciliation).toEqual([{ importId: 1, fileName: "f1.xlsx", ok: true, differences: [] }]);
    expect(v.months).toHaveLength(1);
    expect(v.months[0]).toMatchObject({ month: "2025-01", realized: 820, closes: 1, charges: 47.2 }); // 19.67 + 27.53 from the fills
    expect(v.months[0].est.contracts).toBe(0);
    expect(v.withoutTradebook).toEqual([]);
  });

  test("a long option bought and never sold is closed at zero on its expiry date, as the statement books it", async () => {
    const tb = parseKotakTransactions(await readXlsx(book([rows[2]], { buy: "1,237.50", sell: "0", charges: "12.32", stt: "0" })))[0];
    const st = imp(1, "pnl", { segment: "fno", lines: [glLine("NIFTY 21AUG25 PE 24750", -1237.5, 12.32)] });
    const v = monthlyView(members, accounts, [st, imp(2, "tradebook", { segment: "fno", fills: tb.fills })]);
    expect(v.reconciliation[0]).toMatchObject({ ok: true });
    expect(v.months.find((m) => m.month === "2025-08")).toMatchObject({ realized: -1237.5 }); // the loss lands in the month the contract expired
  });

  test("an option that has not expired yet stays open, whatever the statement says", async () => {
    const tb = parseKotakTransactions(await readXlsx(book([rows[2]], { buy: "1,237.50", sell: "0", charges: "12.32", stt: "0" })))[0];
    const early = imp(2, "tradebook", { segment: "fno", fills: tb.fills, periodTo: "2025-08-10", importedAt: "2025-08-10T00:00:00Z" });
    const st = imp(1, "pnl", { segment: "fno", periodTo: "2025-08-10", lines: [] });
    expect(monthlyView(members, accounts, [st, early]).months.every((m) => m.realized === 0)).toBe(true);
  });

  test("Kotak's rounding of a few paise is not a mismatch, a real difference is", async () => {
    const tb = parseKotakTransactions(await readXlsx(book([rows[0], rows[1]], { buy: "15,000.00", sell: "15,820.00", charges: "39.29", stt: "7.91" })))[0];
    const close = imp(1, "pnl", { lines: [glLine("CRUDEOIL 17FEB25 PE 6350", 820.17, 47.2)] });
    expect(monthlyView(members, accounts, [close, imp(2, "tradebook", { fills: tb.fills })]).reconciliation[0].ok).toBe(true);
    const off = imp(1, "pnl", { lines: [glLine("CRUDEOIL 17FEB25 PE 6350", 900, 47.2)] });
    expect(monthlyView(members, accounts, [off, imp(2, "tradebook", { fills: tb.fills })]).reconciliation[0].ok).toBe(false);
  });

  test("the statement's names, parsed from a real-shaped workbook, are upper-cased so they meet the fills", async () => {
    const gl = makeXlsx([{ name: "Realized Gain-Loss", rows: [[], ["Client Name"], ["Client Code", "XYZ123", null, "Charges", null, 33.25], ["Transaction Period", "From : 2024-04-01 To : 2025-03-31", null, "Net P&L", null, 94.52], ["Transaction Type", "ALL", null, "Segment Type", null, "Derivatives"], [], [], ["Script Name", "Security Type", "ISIN", "Qty", "Buy Amt. (A)", "Sell Amt. (B)", "Gross Realized P&L", null, null, null, "Charges", null, null, null, null, "Net P&L (T - S)", "Gross P&L (T + (C + D + E))"], [null, null, null, null, null, null, "Intraday", "<1yr.", ">1Yr.", "Total (T = B - A)", "GST (C)", "Brokerage (D)", "Misc. (E)", "STT/CTT (S)", "Total (C + D + E + S)", null, null], ["Derivatives"], ["SENSEX 04Jun26 CE 76200", "OPTIDX", "-", 15, 1000, 1100, "-", 100, "NA", 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77], ["Derivatives Total", "", "", 15, 1000, 1100, 0, 100, 0, 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77]] as never }]);
    expect(parseKotakSections(await readXlsx(gl))[0].lines[0].symbol).toBe("SENSEX 04JUN26 CE 76200");
  });
});
