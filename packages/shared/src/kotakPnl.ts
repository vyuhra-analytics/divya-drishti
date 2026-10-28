// Kotak Neo's "Realized Gain-Loss" workbook (Neo > Profile > Reports > Gain & Loss Statement > Excel). Verified against one real F&O file (2024-04-01 to 2025-03-31,
// 147 option contracts). Differences from Zerodha's statement that matter:
//   * It carries NO trade dates for derivatives (the buy and sell date cells are empty), so like Zerodha's statement it supports year-level analysis only.
//   * Its "Realised P&L" is AFTER brokerage, GST and the other charges (the buy and sell amounts already carry them); only STT/CTT is taken off later. So the
//     realised result here is the GROSS column ("Gross P&L ... excluding all charges") and the charges are the "Total" of all four heads, which makes
//     realised minus charges equal Kotak's own "Net P&L" (checked: -16,813.37 - 4,329.20 = -21,142.57). Using the headline "Realised P&L" with the charges
//     would count the brokerage, GST and misc charges twice.
//   * Charges are given per contract (GST, brokerage, misc, STT/CTT), so a Kotak statement can split charges by underlying, which Zerodha's cannot.
//   * The second sheet ("P&L Equity-Tradewise") repeats the same trades with average prices and no dates; it is not read.
// The statement is reconciled against its own totals and a mistaken assumption shows as a problem rather than a wrong number.
import type { Sheet, XlsxCell } from "./xlsx";
import type { ChargeHead, PnlLine, Segment, ZerodhaPnl } from "./zerodhaPnl";

/** `clientName` is the account holder as the file prints it. It is used only to find the member the account belongs to, and never stored. */
export type KotakPnl = Omit<ZerodhaPnl, "broker"> & { broker: "kotak"; clientName?: string };

const TOLERANCE = 0.06; // Kotak rounds each line to paise in several places, so the lines and totals can differ by a few paise
const isNum = (v: XlsxCell | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: XlsxCell | undefined) => (v === null || v === undefined ? "" : String(v).trim());
const low = (v: XlsxCell | undefined) => text(v).toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: XlsxCell | undefined) => (isNum(v) ? v : typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v.trim()) ? Number(v.replace(/,/g, "")) : NaN);

const SEGMENTS: [RegExp, Segment][] = [
  [/^derivatives?$|^f\s*&\s*o$/i, "fno"],
  [/^equity$/i, "equity"],
  [/^currency$/i, "currency"],
  [/^commodity$/i, "commodity"],
];

/** Is this a Kotak Neo Gain-Loss workbook? A sheet called "...Gain-Loss" with the "Script Name" table. */
export function looksLikeKotakPnl(sheets: Sheet[]): boolean {
  return sheets.some((s) => /gain-?\s*loss/i.test(s.name) && s.rows.some((r) => r.some((c) => low(c) === "script name")));
}

/** The first cell to the right of the cell whose text is `label`, anywhere in the first rows. */
function valueAfter(rows: XlsxCell[][], label: string, upTo = 12): XlsxCell | undefined {
  for (const r of rows.slice(0, upTo)) {
    const i = r.findIndex((c) => low(c) === label.toLowerCase());
    if (i >= 0) for (let j = i + 1; j < r.length; j++) if (r[j] !== null && r[j] !== undefined && text(r[j]) !== "") return r[j];
  }
  return undefined;
}

export function parseKotakPnl(sheets: Sheet[]): KotakPnl {
  const sheet = sheets.find((s) => /gain-?\s*loss/i.test(s.name) && s.rows.some((r) => r.some((c) => low(c) === "script name")));
  if (!sheet) throw new Error("this is not a Kotak Neo Gain-Loss statement: no 'Script Name' table found");
  const rows = sheet.rows;

  const clientCode = text(valueAfter(rows, "Client Code"));
  // the holder's name is on one of the sheets (the first one leaves it blank, the trade-wise one prints it)
  const clientName = sheets.map((s) => text(valueAfter(s.rows, "Client Name"))).find((n) => n && !/^client name$/i.test(n));
  const period = /From\s*:\s*(\d{4}-\d{2}-\d{2})\s*To\s*:\s*(\d{4}-\d{2}-\d{2})/i.exec(text(valueAfter(rows, "Transaction Period")));
  if (!period) throw new Error("could not read the statement's period (\"Transaction Period: From ... To ...\")");
  const [periodFrom, periodTo] = [period[1], period[2]];
  if (periodFrom > periodTo) throw new Error(`the statement's period is backwards (${periodFrom} to ${periodTo})`);
  const segWord = text(valueAfter(rows, "Segment Type"));
  const segment = SEGMENTS.find(([re]) => re.test(segWord))?.[1];
  if (!segment) throw new Error(`this report is for "${segWord || "an unknown segment"}", which is not supported yet (Derivatives is; equity, currency and commodity layouts were not seen)`);

  const headerAt = rows.findIndex((r) => low(r[0]) === "script name");
  const header = rows[headerAt];
  const sub = rows[headerAt + 1] ?? [];
  const colOf = (re: RegExp, row: XlsxCell[]) => row.findIndex((c) => re.test(text(c)));
  const cQty = colOf(/^qty/i, header);
  const cBuy = colOf(/^buy amt/i, header);
  const cSell = colOf(/^sell amt/i, header);
  const cGross = colOf(/^gross p&l/i, header);
  const cReal = colOf(/^total\b/i, sub); // the "Total" under the realised P&L group
  const cGst = colOf(/^gst/i, sub);
  const cBrk = colOf(/^brokerage/i, sub);
  const cMisc = colOf(/^misc/i, sub);
  const cStt = colOf(/^stt/i, sub);
  const cNet = colOf(/^net p&l/i, header);
  const missing = Object.entries({ Qty: cQty, "Buy Amt.": cBuy, "Sell Amt.": cSell, "Gross P&L": cGross, Total: cReal, GST: cGst, Brokerage: cBrk, "Misc.": cMisc, "STT/CTT": cStt, "Net P&L": cNet }).filter(([, c]) => c < 0).map(([n]) => n);
  if (missing.length) throw new Error(`the trades table is missing ${missing.join(", ")}`);
  const cTotalCharges = (() => {
    // "Total (C + D + E + S)": the second "Total" in the sub-header, after the four heads
    const i = sub.findIndex((c, k) => k > cStt && /^total\b/i.test(text(c)));
    return i;
  })();
  if (cTotalCharges < 0) throw new Error("the trades table has no total of charges");

  const lines: PnlLine[] = [];
  const problems: string[] = [];
  let totals: XlsxCell[] | undefined;
  const sums = { gst: 0, brk: 0, misc: 0, stt: 0, charges: 0, net: 0 };
  for (let i = headerAt + 2; i < rows.length; i++) {
    const r = rows[i];
    const name = text(r[0]);
    if (!name) continue;
    if (/total$/i.test(name)) {
      totals = r;
      break;
    }
    if (!isNum(r[cQty])) continue; // a section label ("Derivatives")
    const [g, b, m, s, c, n] = [num(r[cGst]), num(r[cBrk]), num(r[cMisc]), num(r[cStt]), num(r[cTotalCharges]), num(r[cNet])];
    const gross = num(r[cGross]);
    if ([gross, g, b, m, s, c, n].some(Number.isNaN)) {
      problems.push(`${name}: a figure is missing or not a number`);
      continue;
    }
    const realisedAfterCharges = num(r[cReal]);
    if (!Number.isNaN(realisedAfterCharges) && Math.abs(realisedAfterCharges + g + b + m - gross) > TOLERANCE) problems.push(`${name}: gross ${gross} is not the realised result ${realisedAfterCharges} plus its charges`);
    if (Math.abs(gross - c - n) > TOLERANCE) problems.push(`${name}: gross ${gross} less charges ${c} is ${round2(gross - c)} but the statement's net is ${n}`);
    lines.push({ symbol: name.replace(/\s+/g, " "), quantity: num(r[cQty]), buyValue: num(r[cBuy]), sellValue: num(r[cSell]), realized: gross, openQuantity: 0, unrealized: 0, charges: c });
    sums.gst += g;
    sums.brk += b;
    sums.misc += m;
    sums.stt += s;
    sums.charges += c;
    sums.net += n;
  }
  if (lines.length === 0) throw new Error("the statement has no trades");

  const charges: ChargeHead[] = [
    { head: "Brokerage", amount: round2(sums.brk) },
    { head: "GST", amount: round2(sums.gst) },
    { head: "Miscellaneous charges (exchange, clearing, stamp, SEBI)", amount: round2(sums.misc) },
    { head: "Securities transaction tax / CTT", amount: round2(sums.stt) },
  ];
  const realized = round2(lines.reduce((a, l) => a + l.realized, 0));
  const totalCharges = round2(sums.charges);

  // reconcile against Kotak's own totals: the header figures and the "Total" row
  const headerCharges = num(valueAfter(rows, "Charges"));
  const headerNet = num(valueAfter(rows, "Net P&L"));
  if (!Number.isNaN(headerCharges) && Math.abs(totalCharges - headerCharges) > TOLERANCE) problems.push(`the contracts' charges add up to ${totalCharges} but the summary says ${headerCharges}`);
  if (!Number.isNaN(headerNet) && Math.abs(round2(realized - totalCharges) - headerNet) > TOLERANCE) problems.push(`gross ${realized} less charges ${totalCharges} is ${round2(realized - totalCharges)} but the summary's net is ${headerNet}`);
  if (totals) {
    const tGross = num(totals[cGross]);
    if (!Number.isNaN(tGross) && Math.abs(tGross - realized) > TOLERANCE) problems.push(`the contracts add up to a gross result of ${realized} but the total row says ${round2(tGross)}`);
  } else problems.push("the statement has no total row, so its contracts could not be checked against one");

  return { broker: "kotak", ...(clientName ? { clientName } : {}), segment, periodFrom, periodTo, clientCode, summary: { charges: totalCharges, otherCreditDebit: 0, realized, unrealized: 0 }, charges, lines, other: [], problems };
}
