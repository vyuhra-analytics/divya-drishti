// Kotak Neo's "Realized Gain-Loss" workbook (Neo > Profile > Reports > Gain & Loss Statement > Excel). Verified against real F&O files of three years (the layout
// changed in 2026-27) and an all-segment file with a Derivatives and a Commodity section. Differences from Zerodha's statement that matter:
//   * It carries NO trade dates for derivatives (the buy and sell date cells are empty), so like Zerodha's statement it supports year-level analysis only.
//   * Its "Realised P&L" is AFTER brokerage, GST and the other charges (the buy and sell amounts already carry them); only STT/CTT is taken off later. So the
//     realised result here is the GROSS column ("Gross P&L ... excluding all charges") and the charges are the "Total" of all four heads, which makes
//     realised minus charges equal Kotak's own "Net P&L" (checked: -16,813.37 - 4,329.20 = -21,142.57). Using the headline "Realised P&L" with the charges
//     would count the brokerage, GST and misc charges twice.
//   * Charges are given per contract (GST, brokerage, misc, STT/CTT), so a Kotak statement can split charges by underlying, which Zerodha's cannot. From 2026-27
//     each head has a Buy and a Sell column ("Buy GST (C)", "Sell GST (C)") and a "Total Charges" column; a head is the sum of its columns.
//   * One file can hold SEVERAL segments, each a section of the same sheet ("Derivatives", "Commodity") with its own "<Section> Total" row and a "Grand Total"
//     after them. Each section is read as a statement of its own segment, so equity derivatives and MCX commodity stay apart.
//   * The second sheet ("P&L Equity-Tradewise") repeats the same trades with average prices and no dates; it is not read.
// Each section is reconciled against its own total row and the whole file against the header's charges and net, so a mistaken assumption shows as a problem
// rather than a wrong number.
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

/**
 * Every segment of a Kotak Gain-Loss workbook as a statement of its own: one for a single-segment file, one per section ("Derivatives", "Commodity") for an
 * all-segment file. Throws an Error whose message says what is wrong in plain words.
 */
export function parseKotakSections(sheets: Sheet[]): KotakPnl[] {
  const sheet = sheets.find((s) => /gain-?\s*loss/i.test(s.name) && s.rows.some((r) => r.some((c) => low(c) === "script name")));
  if (!sheet) throw new Error("this is not a Kotak Neo Gain-Loss statement: no 'Script Name' table found");
  const rows = sheet.rows;

  const clientCode = text(valueAfter(rows, "Client Code"));
  // the holder's name is on one of the sheets (the first one may leave it blank, the trade-wise one prints it)
  const clientName = sheets.map((s) => text(valueAfter(s.rows, "Client Name"))).find((n) => n && !/^client name$/i.test(n));
  const period = /From\s*:\s*(\d{4}-\d{2}-\d{2})\s*To\s*:\s*(\d{4}-\d{2}-\d{2})/i.exec(text(valueAfter(rows, "Transaction Period")));
  if (!period) throw new Error("could not read the statement's period (\"Transaction Period: From ... To ...\")");
  const [periodFrom, periodTo] = [period[1], period[2]];
  if (periodFrom > periodTo) throw new Error(`the statement's period is backwards (${periodFrom} to ${periodTo})`);
  const segWord = text(valueAfter(rows, "Segment Type"));

  const headerAt = rows.findIndex((r) => low(r[0]) === "script name");
  const header = rows[headerAt];
  const sub = rows[headerAt + 1] ?? [];
  const colOf = (re: RegExp, row: XlsxCell[]) => row.findIndex((c) => re.test(text(c)));
  const cQty = colOf(/^qty/i, header);
  const cBuy = colOf(/^buy amt/i, header);
  const cSell = colOf(/^sell amt/i, header);
  const cGross = colOf(/^gross p&l/i, header);
  const cReal = colOf(/^total\b/i, sub); // the "Total" under the realised P&L group
  // each charge head is one column in the older layout ("GST (C)") and two in the newer one ("Buy GST (C)" and "Sell GST (C)"), so a head is the sum of its columns
  const colsOf = (re: RegExp) => sub.flatMap((c, k) => (re.test(text(c)) ? [k] : []));
  const cGst = colsOf(/\bgst\b/i);
  const cBrk = colsOf(/\bbrokerage\b/i);
  const cMisc = colsOf(/\bmisc/i);
  const cStt = colsOf(/\bstt\b/i);
  const cNet = colOf(/^net p&l/i, header);
  const missing = Object.entries({ Qty: cQty, "Buy Amt.": cBuy, "Sell Amt.": cSell, "Gross P&L": cGross, Total: cReal, GST: cGst[0] ?? -1, Brokerage: cBrk[0] ?? -1, "Misc.": cMisc[0] ?? -1, "STT/CTT": cStt[0] ?? -1, "Net P&L": cNet }).filter(([, c]) => c < 0).map(([n]) => n);
  if (missing.length) throw new Error(`the trades table is missing ${missing.join(", ")}`);
  const cTotalCharges = (() => {
    // the newer layout names it "Total Charges"; the older one calls it "Total (C + D + E + S)", the second "Total" in the sub-header, after the four heads
    const named = sub.findIndex((c) => /^total charges/i.test(text(c)));
    if (named >= 0) return named;
    const lastHead = Math.max(...cStt, ...cGst, ...cBrk, ...cMisc);
    return sub.findIndex((c, k) => k > lastHead && /^total\b/i.test(text(c)));
  })();
  if (cTotalCharges < 0) throw new Error("the trades table has no total of charges");

  // walk the rows: a row with only a name is a section label ("Derivatives"), a row ending in "Total" closes the section before it, the rest are contracts
  interface Section {
    name: string;
    lines: PnlLine[];
    problems: string[];
    sums: { gst: number; brk: number; misc: number; stt: number; charges: number; net: number };
    total?: XlsxCell[];
  }
  const sections: Section[] = [];
  const open = (name: string): Section => {
    const s: Section = { name, lines: [], problems: [], sums: { gst: 0, brk: 0, misc: 0, stt: 0, charges: 0, net: 0 } };
    sections.push(s);
    return s;
  };
  let cur: Section | undefined;
  for (let i = headerAt + 2; i < rows.length; i++) {
    const r = rows[i];
    const name = text(r[0]);
    if (!name) continue;
    if (/^disclaimer$/i.test(name)) break;
    if (/^grand total$/i.test(name)) continue;
    if (/ total$/i.test(name)) {
      if (cur) cur.total = r;
      continue;
    }
    if (!isNum(r[cQty])) {
      cur = open(name); // a section label
      continue;
    }
    cur ??= open(segWord); // contracts before any label: the whole file is the one segment the header names
    const sumOf = (cols: number[]) => cols.reduce((a, k) => a + num(r[k]), 0);
    const [g, b, m, s, c, n] = [sumOf(cGst), sumOf(cBrk), sumOf(cMisc), sumOf(cStt), num(r[cTotalCharges]), num(r[cNet])];
    const gross = num(r[cGross]);
    if ([gross, g, b, m, s, c, n].some(Number.isNaN)) {
      cur.problems.push(`${name}: a figure is missing or not a number`);
      continue;
    }
    const realisedAfterCharges = num(r[cReal]);
    if (!Number.isNaN(realisedAfterCharges) && Math.abs(realisedAfterCharges + g + b + m - gross) > TOLERANCE) cur.problems.push(`${name}: gross ${gross} is not the realised result ${realisedAfterCharges} plus its charges`);
    if (Math.abs(gross - c - n) > TOLERANCE) cur.problems.push(`${name}: gross ${gross} less charges ${c} is ${round2(gross - c)} but the statement's net is ${n}`);
    cur.lines.push({ symbol: name.replace(/\s+/g, " ").toUpperCase(), quantity: num(r[cQty]), buyValue: num(r[cBuy]), sellValue: num(r[cSell]), realized: gross, openQuantity: 0, unrealized: 0, charges: c });
    cur.sums.gst += g;
    cur.sums.brk += b;
    cur.sums.misc += m;
    cur.sums.stt += s;
    cur.sums.charges += c;
    cur.sums.net += n;
  }
  const filled = sections.filter((s) => s.lines.length > 0);
  if (filled.length === 0) throw new Error("the statement has no trades");

  // the file's own header totals cover every section together
  const headerCharges = num(valueAfter(rows, "Charges"));
  const headerNet = num(valueAfter(rows, "Net P&L"));
  const allGross = filled.reduce((a, s) => a + s.lines.reduce((x, l) => x + l.realized, 0), 0);
  const allCharges = filled.reduce((a, s) => a + s.sums.charges, 0);
  const fileProblems: string[] = [];
  if (!Number.isNaN(headerCharges) && Math.abs(round2(allCharges) - headerCharges) > TOLERANCE) fileProblems.push(`the contracts' charges add up to ${round2(allCharges)} but the summary says ${headerCharges}`);
  if (!Number.isNaN(headerNet) && Math.abs(round2(allGross - allCharges) - headerNet) > TOLERANCE) fileProblems.push(`gross ${round2(allGross)} less charges ${round2(allCharges)} is ${round2(allGross - allCharges)} but the summary's net is ${headerNet}`);

  return filled.map((sec, n) => {
    const segment = SEGMENTS.find(([re]) => re.test(sec.name))?.[1];
    if (!segment) throw new Error(`this report has a "${sec.name || "unnamed"}" section, which is not supported yet (Derivatives and Commodity are; equity, currency and mutual fund layouts were not seen)`);
    const problems = [...sec.problems];
    const realized = round2(sec.lines.reduce((a, l) => a + l.realized, 0));
    const totalCharges = round2(sec.sums.charges);
    if (sec.total) {
      const tGross = num(sec.total[cGross]);
      if (!Number.isNaN(tGross) && Math.abs(tGross - realized) > TOLERANCE) problems.push(`the ${sec.name} contracts add up to a gross result of ${realized} but the section's total row says ${round2(tGross)}`);
    } else problems.push(`the ${sec.name} section has no total row, so its contracts could not be checked against one`);
    if (n === 0) problems.push(...fileProblems); // a problem with the file as a whole is reported once
    const charges: ChargeHead[] = [
      { head: "Brokerage", amount: round2(sec.sums.brk) },
      { head: "GST", amount: round2(sec.sums.gst) },
      { head: "Miscellaneous charges (exchange, clearing, stamp, SEBI)", amount: round2(sec.sums.misc) },
      { head: "Securities transaction tax / CTT", amount: round2(sec.sums.stt) },
    ];
    return { broker: "kotak" as const, ...(clientName ? { clientName } : {}), segment, periodFrom, periodTo, clientCode, summary: { charges: totalCharges, otherCreditDebit: 0, realized, unrealized: 0 }, charges, lines: sec.lines, other: [], problems };
  });
}

/** A single-segment Kotak statement. For a file with several segments use `parseKotakSections`. */
export function parseKotakPnl(sheets: Sheet[]): KotakPnl {
  const all = parseKotakSections(sheets);
  if (all.length > 1) throw new Error(`this statement has ${all.length} segments (${all.map((p) => p.segment).join(", ")}): read it with parseKotakSections`);
  return all[0];
}
