// Kotak Neo's "Transaction Statement" workbook (Neo > Profile > Reports > Transaction Statement > Excel): one sheet ("On Market") of every fill with its trade date,
// time, security name, exchange, buy or sell, quantity, rate and the charges on that fill. This is Kotak's TRADEBOOK, the dated counterpart of its Gain & Loss
// statement, which has no dates: with it the months of a Kotak account are exact. Verified against two real years (about 660 fills, NSE derivatives and MCX in one
// file). What differs from Zerodha's tradebook:
//   * No exchange trade id. A fill gets a made-up id from its date, time, contract, side, quantity and rate, plus a counter for identical rows in the same file.
//   * One file holds several segments: the exchange column says which (an MCX row is commodity, an NSE or BSE derivatives row is futures and options), so each
//     segment is returned as a tradebook of its own, like the all-segment Gain & Loss report.
//   * The security name is written "OPTFUTCRUDEOIL  17FEB2025PE   6350.00" (an instrument-type prefix, the underlying padded, the expiry, the option type and the
//     strike); it is turned into the form Kotak's Gain & Loss statement uses ("CRUDEOIL 17FEB25 PE 6350") so the two reconcile contract by contract.
//   * Every fill carries its own charges: GST, brokerage and misc in "Total Charges", STT/CTT in a column of its own. Both are kept (`Fill.charges`), so a month's
//     charges are exact, not shared out.
//   * The header gives the file's totals (buy value, sell value, charges, STT), which the fills are checked against.
import { excelDate, type Segment } from "./zerodhaPnl";
import type { Sheet, XlsxCell } from "./xlsx";
import type { Fill } from "./zerodhaTradebook";

export interface KotakTradebook {
  broker: "kotak";
  segment: Segment;
  periodFrom: string;
  periodTo: string;
  clientCode: string;
  /** the account holder as the file prints it: used only to find the member, never stored */
  clientName?: string;
  fills: Fill[];
  /** things worth a warning that did not stop the read (the file's own totals disagreeing with its fills, a row that was skipped) */
  notes: string[];
}

const text = (v: XlsxCell | undefined) => (v === null || v === undefined ? "" : String(v).trim());
const low = (v: XlsxCell | undefined) => text(v).toLowerCase();
const num = (v: XlsxCell | undefined): number => (typeof v === "number" ? v : /^-?[\d,]+(\.\d+)?$/.test(text(v)) ? Number(text(v).replace(/,/g, "")) : Number.NaN);
const round2 = (n: number) => Math.round(n * 100) / 100;
const MONTHS = new Set(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]);

const isTransactionSheet = (s: Sheet) => s.rows.some((r) => low(r[0]) === "trade date" && r.some((c) => low(c) === "security name") && r.some((c) => low(c) === "transaction type"));

/** Is this a Kotak Neo Transaction Statement? A sheet whose table starts with "Trade Date" and has "Security Name" and "Transaction Type". */
export function looksLikeKotakTransactions(sheets: Sheet[]): boolean {
  return sheets.some(isTransactionSheet);
}

/**
 * "OPTFUTCRUDEOIL  17FEB2025PE   6350.00" -> "CRUDEOIL 17FEB25 PE 6350", "FUTIDXNIFTY 28NOV2024" -> "NIFTY 28NOV24 FUT". Upper case, single spaces, the strike without
 * trailing zeros, so it equals the name in Kotak's Gain & Loss statement once that is upper-cased. Undefined for a name that is not a derivatives contract.
 */
export function kotakContractName(raw: string): string | undefined {
  // the underlying is padded to a fixed width, so once the spaces are collapsed the name is "OPTFUTCRUDEOIL 17FEB2025PE 6350.00", or "OPTSTKHEROMOTOCO26DEC2024CE 5100.00" when the underlying fills the width and runs into the date
  const m = /^(?:OPT|FUT)(?:FUT|IDX|STK|COM|CUR)([A-Z0-9&-]+?)\s*(\d{2})([A-Z]{3})(\d{4})(?:\s*(CE|PE)\s+([\d.]+))?$/.exec(raw.trim().toUpperCase().replace(/\s+/g, " "));
  if (!m || !MONTHS.has(m[3])) return undefined;
  const [, under, dd, mon, yyyy, type, strike] = m;
  return type ? `${under} ${dd}${mon}${yyyy.slice(2)} ${type} ${Number(strike)}` : `${under} ${dd}${mon}${yyyy.slice(2)} FUT`;
}

/** The first cell to the right of the cell labelled `label` in the first rows. */
function after(rows: XlsxCell[][], label: string): XlsxCell | undefined {
  for (const r of rows.slice(0, 12)) {
    const i = r.findIndex((c) => low(c) === label.toLowerCase());
    if (i >= 0) for (let j = i + 1; j < r.length; j++) if (text(r[j]) !== "") return r[j];
  }
  return undefined;
}

/** "27/01/2025" (or an Excel date) -> "2025-01-27". */
function tradeDate(v: XlsxCell | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text(v));
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return typeof v === "number" ? excelDate(v) : /^\d{4}-\d{2}-\d{2}/.test(text(v)) ? text(v).slice(0, 10) : null;
}

/** Every segment of a Kotak Transaction Statement as a tradebook of its own. Throws an Error that says what is wrong in plain words. */
export function parseKotakTransactions(sheets: Sheet[]): KotakTradebook[] {
  const sheet = sheets.find(isTransactionSheet);
  if (!sheet) throw new Error("this is not a Kotak Neo Transaction Statement: no 'Trade Date' table found");
  const rows = sheet.rows;
  const clientCode = text(after(rows, "Client Code"));
  const clientName = sheets.map((s) => text(after(s.rows, "Client Name"))).find((n) => n && !/^client name$/i.test(n));
  const period = /From\s*:\s*(\d{4}-\d{2}-\d{2})\s*To\s*:\s*(\d{4}-\d{2}-\d{2})/i.exec(text(after(rows, "Transaction Period")));
  if (!period) throw new Error("could not read the statement's period (\"Transaction Period: From ... To ...\")");
  const [periodFrom, periodTo] = [period[1], period[2]];
  if (periodFrom > periodTo) throw new Error(`the statement's period is backwards (${periodFrom} to ${periodTo})`);

  const headerAt = rows.findIndex((r) => low(r[0]) === "trade date");
  const header = rows[headerAt];
  const col = (name: string) => header.findIndex((h) => low(h) === name.toLowerCase());
  const c = { date: col("Trade Date"), time: col("Trade Time"), name: col("Security Name"), exch: col("Exchange"), side: col("Transaction Type"), qty: col("Quantity"), rate: col("Market Rate"), total: col("Total Charges"), stt: col("STT/CTT") };
  const missing = Object.entries({ "Trade Date": c.date, "Security Name": c.name, Exchange: c.exch, "Transaction Type": c.side, Quantity: c.qty, "Market Rate": c.rate, "Total Charges": c.total, "STT/CTT": c.stt }).filter(([, i]) => i < 0).map(([n]) => n);
  if (missing.length) throw new Error(`the transactions table is missing ${missing.join(", ")}`);

  const segments = new Map<Segment, { fills: Fill[]; notes: string[]; buy: number; sell: number; charges: number; stt: number }>();
  const seen = new Map<string, number>();
  const skipped: string[] = [];
  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i];
    if (text(r[c.date]) === "" && text(r[c.name]) === "") continue;
    const date = tradeDate(r[c.date]);
    const side = low(r[c.side]);
    const name = kotakContractName(text(r[c.name]));
    const exch = text(r[c.exch]).toUpperCase();
    const qty = num(r[c.qty]);
    const price = num(r[c.rate]);
    if (!date || (side !== "buy" && side !== "sell") || !(qty > 0) || !(price >= 0)) {
      skipped.push(`row ${i + 1}: not a readable trade`);
      continue;
    }
    if (!name) throw new Error(`row ${i + 1}: "${text(r[c.name])}" is not a derivatives contract this reader knows (equity and other sections were not seen)`);
    const segment: Segment | undefined = exch.startsWith("MCX") ? "commodity" : /DERV|NFO|BFO|FNO/.test(exch) ? "fno" : undefined;
    if (!segment) throw new Error(`row ${i + 1}: exchange "${exch}" is not supported yet (NSE and BSE derivatives, and MCX, are)`);
    const time = /^\d{2}:\d{2}:\d{2}$/.test(text(r[c.time])) ? `${date}T${text(r[c.time])}` : null;
    // no exchange trade id in this file: an identical row in the same file (same second, contract, side, quantity and rate) gets a counter
    const key = `${date}T${text(r[c.time])}|${name}|${side}|${qty}|${price}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const charges = (Number.isNaN(num(r[c.total])) ? 0 : num(r[c.total])) + (Number.isNaN(num(r[c.stt])) ? 0 : num(r[c.stt]));
    const seg = segments.get(segment) ?? { fills: [], notes: [], buy: 0, sell: 0, charges: 0, stt: 0 };
    segments.set(segment, seg);
    seg.fills.push({ symbol: name, date, time, side, quantity: qty, price, tradeId: `K:${key}#${n}`, exchange: exch, charges: round2(charges) });
    if (side === "buy") seg.buy += qty * price;
    else seg.sell += qty * price;
    seg.charges += Number.isNaN(num(r[c.total])) ? 0 : num(r[c.total]);
    seg.stt += Number.isNaN(num(r[c.stt])) ? 0 : num(r[c.stt]);
  }
  if (segments.size === 0) throw new Error("the statement has no trades");

  // the file's own totals cover every segment together
  const sum = (f: (s: { buy: number; sell: number; charges: number; stt: number }) => number) => [...segments.values()].reduce((a, s) => a + f(s), 0);
  const checks: [string, number | undefined, number][] = [
    ["buy value", num(after(rows, "Total Buy Value")), sum((s) => s.buy)],
    ["sell value", num(after(rows, "Total Sell Value")), sum((s) => s.sell)],
    ["charges", num(after(rows, "Charges")), sum((s) => s.charges)],
    ["STT/CTT", num(after(rows, "STT/CTT")), sum((s) => s.stt)],
  ];
  const fileNotes = checks.filter(([, said, got]) => said !== undefined && !Number.isNaN(said) && Math.abs(said - got) > 0.06 + 0.00001 * Math.abs(said)).map(([what, said, got]) => `the file says ${what} is ${said} but its fills add up to ${round2(got)}`);

  return [...segments.entries()].map(([segment, s], k) => {
    const fills = s.fills.sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")) || a.tradeId.localeCompare(b.tradeId));
    return { broker: "kotak" as const, segment, periodFrom, periodTo, clientCode, ...(clientName ? { clientName } : {}), fills, notes: [...(k === 0 ? [...skipped, ...fileNotes] : [])] };
  });
}
