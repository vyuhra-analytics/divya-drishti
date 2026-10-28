// Zerodha Console's tradebook workbook (Console > Reports > Tradebook > Download): one row per fill with the trade date, symbol, side, quantity, price and
// the exchange's trade id. Unlike the P&L statement it HAS dates, so it is the source of the month-by-month view; the two are reconciled symbol by symbol.
// Verified against one real F&O tradebook. The client id is how a file finds its account.
import { readXlsx, type XlsxCell, type Sheet } from "./xlsx";
import { excelDate } from "./zerodhaPnl";
import type { Segment } from "./zerodhaPnl";

export interface Fill {
  symbol: string;
  /** YYYY-MM-DD, the trade date the broker reports */
  date: string;
  /** the exchange's execution time when the file has it (ISO local time), else null */
  time: string | null;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  /** the exchange's trade id: a repeat of the same id is the same fill */
  tradeId: string;
  exchange: string;
}
export interface ZerodhaTradebook {
  broker: "zerodha";
  segment: Segment;
  periodFrom: string;
  periodTo: string;
  clientCode: string;
  fills: Fill[];
  /** things worth a warning that did not stop the read (a duplicate trade id, an auction trade) */
  notes: string[];
}

const text = (v: XlsxCell | undefined) => (v === null || v === undefined ? "" : String(v).trim());
const isNum = (v: XlsxCell): v is number => typeof v === "number" && Number.isFinite(v);
const sameLabel = (v: XlsxCell | undefined, label: string) => text(v).toLowerCase() === label.toLowerCase();

const SEGMENT_WORDS: [RegExp, Segment][] = [
  [/^f\s*&\s*o$|^fo$/i, "fno"],
  [/^equity$/i, "equity"],
  [/^currency$/i, "currency"],
  [/^commodity$/i, "commodity"],
];

export function looksLikeZerodhaTradebook(sheets: Sheet[]): boolean {
  return sheets.some((s) => s.rows.some((r) => /^Tradebook for /i.test(text(r[1]))));
}

export function parseZerodhaTradebook(sheets: Sheet[]): ZerodhaTradebook {
  const sheet = sheets.find((s) => s.rows.some((r) => /^Tradebook for /i.test(text(r[1]))));
  if (!sheet) throw new Error("this is not a Zerodha tradebook: no 'Tradebook for ...' title found");
  const rows = sheet.rows;
  const title = rows.map((r) => text(r[1])).find((t) => /^Tradebook for /i.test(t))!;
  const t = /^Tradebook for (.+?) from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})\s*$/i.exec(title);
  if (!t) throw new Error(`could not read the tradebook title: "${title}"`);
  const segment = SEGMENT_WORDS.find(([re]) => re.test(t[1].trim()))?.[1];
  if (!segment) throw new Error(`this tradebook is for "${t[1]}", which is not supported yet`);
  const clientCode = text(rows.find((r) => sameLabel(r[1], "Client ID"))?.[2]);

  const hRow = rows.findIndex((r) => sameLabel(r[1], "Symbol"));
  if (hRow < 0) throw new Error('the tradebook has no trades table ("Symbol")');
  const header = rows[hRow];
  const col = (n: string) => header.findIndex((h) => sameLabel(h, n));
  const c = { date: col("Trade Date"), exch: col("Exchange"), type: col("Trade Type"), qty: col("Quantity"), price: col("Price"), id: col("Trade ID"), time: col("Order Execution Time"), auction: col("Auction") };
  for (const [k, v] of Object.entries(c)) if (v < 0 && k !== "time" && k !== "auction" && k !== "exch") throw new Error(`the tradebook is missing the "${k}" column`);

  const fills: Fill[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (let i = hRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const symbol = text(r[1]);
    if (!symbol) break;
    const date = excelDate(r[c.date]);
    const side = text(r[c.type]).toLowerCase();
    if (!date) throw new Error(`the trade for ${symbol} on row ${i + 1} has no readable date`);
    if (side !== "buy" && side !== "sell") throw new Error(`the trade for ${symbol} on ${date} has a trade type "${side}" (expected buy or sell)`);
    const quantity = r[c.qty];
    const price = r[c.price];
    if (!isNum(quantity) || !(quantity > 0) || !isNum(price) || !(price >= 0)) throw new Error(`the trade for ${symbol} on ${date} has a bad quantity or price`);
    const tradeId = text(r[c.id]);
    if (!tradeId) throw new Error(`the trade for ${symbol} on ${date} has no trade id`);
    if (seen.has(tradeId)) {
      notes.push(`trade id ${tradeId} appears twice (${symbol}, ${date}): the second row was skipped`);
      continue;
    }
    seen.add(tradeId);
    if (c.auction >= 0 && isNum(r[c.auction]) && r[c.auction] !== 0) notes.push(`${symbol} on ${date} is an auction trade`);
    const time = c.time >= 0 ? text(r[c.time]) || null : null;
    fills.push({ symbol, date, time, side, quantity, price, tradeId, exchange: c.exch >= 0 ? text(r[c.exch]) : "" });
  }
  return { broker: "zerodha", segment, periodFrom: t[2], periodTo: t[3], clientCode, fills, notes };
}

export async function readZerodhaTradebook(bytes: Uint8Array): Promise<ZerodhaTradebook> {
  return parseZerodhaTradebook(await readXlsx(bytes));
}
