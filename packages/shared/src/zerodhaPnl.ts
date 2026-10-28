// Zerodha Console's "P&L statement" workbook (Console > Reports > P&L > Download): one sheet per segment report with a summary, the charges by head and
// one realised line per symbol, plus a sheet of other debits and credits. The statement carries the period it covers but NO trade dates, so it supports
// year-level analysis only; month-level needs the tradebook. Verified against one real F&O statement (a workbook of 2024-04-01 to 2024-10-28); the equity,
// currency and commodity reports are assumed to share the layout, and every statement is reconciled against its own totals so a mistaken assumption shows.
// The client id in the file is returned (it is how a file finds its account); the screens show it masked unless asked.
import { readXlsx, type XlsxCell, type Sheet } from "./xlsx";

export type Segment = "fno" | "equity" | "currency" | "commodity";
export const SEGMENT_LABELS: Record<Segment, string> = { fno: "Equity F&O", equity: "Equity", currency: "Currency", commodity: "Commodity" };

export interface PnlLine {
  symbol: string;
  quantity: number;
  buyValue: number;
  sellValue: number;
  realized: number;
  /** a position still open at the end of the period, with its unrealised result as the broker reported it */
  openQuantity: number;
  unrealized: number;
  /** the charges on this contract alone, when the broker's statement gives them (Kotak's does, Zerodha's gives one total for the period) */
  charges?: number;
}
export interface ChargeHead {
  head: string;
  amount: number;
}
export interface OtherEntry {
  particulars: string;
  date: string | null;
  debit: number;
  credit: number;
}
export interface ZerodhaPnl {
  broker: "zerodha";
  segment: Segment;
  periodFrom: string;
  periodTo: string;
  /** the broker's client id as printed in the file: it identifies the account, it is not a credential */
  clientCode: string;
  summary: { charges: number; otherCreditDebit: number; realized: number; unrealized: number };
  charges: ChargeHead[];
  lines: PnlLine[];
  other: OtherEntry[];
  /** where the statement disagrees with itself (a total that is not the sum of its rows); empty means every total reconciled */
  problems: string[];
}

const TOLERANCE = 0.011; // the statement rounds to four decimals; a paisa is a real difference

const isNum = (v: XlsxCell): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: XlsxCell | undefined) => (v === null || v === undefined ? "" : String(v).trim());
const sameLabel = (v: XlsxCell | undefined, label: string) => text(v).toLowerCase() === label.toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** An Excel serial day number (the 1900 system) to YYYY-MM-DD, or null. */
export function excelDate(v: XlsxCell): string | null {
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  if (!isNum(v) || v < 1) return null;
  return new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10);
}

const SEGMENT_WORDS: [RegExp, Segment][] = [
  [/^f\s*&\s*o$|^fo$|^futures? (and|&) options$/i, "fno"],
  [/^equity$/i, "equity"],
  [/^currency$/i, "currency"],
  [/^commodity$/i, "commodity"],
];

/** Does this workbook look like a Zerodha P&L statement? Cheap, so the caller can tell the user what they uploaded. */
export function looksLikeZerodhaPnl(sheets: Sheet[]): boolean {
  return sheets.some((s) => s.rows.some((r) => /^P&L Statement for /i.test(text(r[1]))));
}

/** Parses a workbook's sheets into a statement. Throws an Error whose message says what is wrong in plain words. */
export function parseZerodhaPnl(sheets: Sheet[]): ZerodhaPnl {
  const main = sheets.find((s) => s.rows.some((r) => /^P&L Statement for /i.test(text(r[1]))));
  if (!main) throw new Error("this is not a Zerodha P&L statement: no 'P&L Statement for ...' title found");
  const rows = main.rows;
  const title = rows.map((r) => text(r[1])).find((t) => /^P&L Statement for /i.test(t))!;
  const t = /^P&L Statement for (.+?) from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})\s*$/i.exec(title);
  if (!t) throw new Error(`could not read the statement title: "${title}"`);
  const segment = SEGMENT_WORDS.find(([re]) => re.test(t[1].trim()))?.[1];
  if (!segment) throw new Error(`this report is for "${t[1]}", which is not supported yet (F&O, equity, currency and commodity statements are)`);
  const periodFrom = t[2];
  const periodTo = t[3];
  if (periodFrom > periodTo) throw new Error(`the statement's period is backwards (${periodFrom} to ${periodTo})`);

  const clientRow = rows.find((r) => sameLabel(r[1], "Client ID"));
  const clientCode = text(clientRow?.[2]);

  // summary: label in column B with a number in C, before the charges table
  const sum = { charges: NaN, otherCreditDebit: NaN, realized: NaN, unrealized: NaN };
  for (const r of rows) {
    const label = text(r[1]).toLowerCase();
    if (!isNum(r[2])) continue;
    if (label === "charges" && Number.isNaN(sum.charges)) sum.charges = r[2];
    else if (label === "other credit & debit") sum.otherCreditDebit = r[2];
    else if (label === "realized p&l") sum.realized = r[2];
    else if (label === "unrealized p&l") sum.unrealized = r[2];
  }
  for (const [k, v] of Object.entries(sum)) if (Number.isNaN(v)) throw new Error(`the statement's summary has no "${k}" figure`);

  // charges by head: the rows under the "Account Head" header
  const charges: ChargeHead[] = [];
  const headRow = rows.findIndex((r) => sameLabel(r[1], "Account Head"));
  if (headRow < 0) throw new Error('the statement has no charges table ("Account Head")');
  for (let i = headRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const head = text(r[1]);
    if (!head) break;
    if (!isNum(r[2])) throw new Error(`charge "${head}" has no amount`);
    charges.push({ head, amount: r[2] });
  }

  // realised lines: the table whose header row starts with "Symbol"
  const symRow = rows.findIndex((r) => sameLabel(r[1], "Symbol"));
  if (symRow < 0) throw new Error('the statement has no trades table ("Symbol")');
  const header = rows[symRow];
  const col = (name: string) => header.findIndex((h) => sameLabel(h, name));
  const cQty = col("Quantity");
  const cBuy = col("Buy Value");
  const cSell = col("Sell Value");
  const cReal = col("Realized P&L");
  if ([cQty, cBuy, cSell, cReal].some((c) => c < 0)) throw new Error("the trades table is missing Quantity, Buy Value, Sell Value or Realized P&L");
  const cOpenQty = col("Open Quantity");
  const cUnreal = col("Unrealized P&L");
  const lines: PnlLine[] = [];
  const problems: string[] = [];
  for (let i = symRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const symbol = text(r[1]);
    if (!symbol) break;
    if (![cQty, cBuy, cSell, cReal].every((c) => isNum(r[c]))) throw new Error(`the row for ${symbol} has a missing or non-numeric figure`);
    const line: PnlLine = { symbol, quantity: r[cQty] as number, buyValue: r[cBuy] as number, sellValue: r[cSell] as number, realized: r[cReal] as number, openQuantity: cOpenQty >= 0 && isNum(r[cOpenQty]) ? (r[cOpenQty] as number) : 0, unrealized: cUnreal >= 0 && isNum(r[cUnreal]) ? (r[cUnreal] as number) : 0 };
    if (Math.abs(line.sellValue - line.buyValue - line.realized) > TOLERANCE) problems.push(`${symbol}: sell value minus buy value is ${round2(line.sellValue - line.buyValue)} but the statement says ${line.realized}`);
    lines.push(line);
  }

  // other debits and credits (a second sheet, often empty)
  const other: OtherEntry[] = [];
  const otherSheet = sheets.find((s) => s !== main && s.rows.some((r) => sameLabel(r[1], "Particulars")));
  if (otherSheet) {
    const h = otherSheet.rows.findIndex((r) => sameLabel(r[1], "Particulars"));
    for (let i = h + 1; i < otherSheet.rows.length; i++) {
      const r = otherSheet.rows[i];
      const particulars = text(r[1]);
      if (!particulars) break;
      other.push({ particulars, date: excelDate(r[2]), debit: isNum(r[3]) ? r[3] : 0, credit: isNum(r[4]) ? r[4] : 0 });
    }
  }

  const totalReal = lines.reduce((a, l) => a + l.realized, 0);
  const totalCharges = charges.reduce((a, c) => a + c.amount, 0);
  const totalUnreal = lines.reduce((a, l) => a + l.unrealized, 0);
  if (Math.abs(totalReal - sum.realized) > TOLERANCE) problems.push(`the symbols add up to a realised P&L of ${round2(totalReal)} but the summary says ${sum.realized}`);
  if (Math.abs(totalCharges - sum.charges) > TOLERANCE) problems.push(`the charges add up to ${round2(totalCharges)} but the summary says ${sum.charges}`);
  if (Math.abs(totalUnreal - sum.unrealized) > TOLERANCE) problems.push(`the symbols add up to an unrealised P&L of ${round2(totalUnreal)} but the summary says ${sum.unrealized}`);
  const netOther = other.reduce((a, o) => a + o.credit - o.debit, 0);
  if (Math.abs(netOther - sum.otherCreditDebit) > TOLERANCE) problems.push(`the other debits and credits add up to ${round2(netOther)} but the summary says ${sum.otherCreditDebit}`);

  return { broker: "zerodha", segment, periodFrom, periodTo, clientCode, summary: sum, charges, lines, other, problems };
}

/** Reads the bytes of an .xlsx file as a Zerodha P&L statement. */
export async function readZerodhaPnl(bytes: Uint8Array): Promise<ZerodhaPnl> {
  return parseZerodhaPnl(await readXlsx(bytes));
}
