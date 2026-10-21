// SEC Form 4 (insider transactions) parsing. Pure so it can be tested against a fixture.

/** Energy majors tracked, with their SEC CIK. */
export const INSIDER_TICKERS: Record<string, number> = {
  XOM: 34088,
  CVX: 93410,
  COP: 1163165,
  OXY: 797468,
  SLB: 87347,
  EOG: 821189,
};

export interface InsiderTrade {
  ticker: string;
  owner: string;
  title?: string;
  /** transaction date YYYY-MM-DD */
  date: string;
  /** SEC transaction code: P purchase, S sale, A grant, M option exercise, F tax withholding, ... */
  code: string;
  /** shares acquired (+) or disposed (-) */
  shares: number;
  price?: number;
  /** abs(shares) × price when a price was reported */
  value?: number;
  /** link to the filing index */
  url: string;
}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
/** <name><value>x</value></name> */
const val = (xml: string, name: string) => {
  const inner = tag(xml, name);
  return inner === undefined ? undefined : (tag(inner, "value") ?? inner).trim();
};

/** Non-derivative transactions of one Form 4 XML document. */
export function parseForm4(xml: string, ticker: string, url: string): InsiderTrade[] {
  const owner = tag(xml, "rptOwnerName")?.trim() ?? "Unknown";
  const title = tag(xml, "officerTitle")?.trim() || (tag(xml, "isDirector")?.trim().match(/^(1|true)$/) ? "Director" : undefined);
  const out: InsiderTrade[] = [];
  for (const m of xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
    const t = m[1];
    const date = val(t, "transactionDate")?.slice(0, 10);
    const code = tag(tag(t, "transactionCoding") ?? "", "transactionCode")?.trim();
    const n = Number(val(t, "transactionShares"));
    if (!date || !code || !Number.isFinite(n)) continue;
    const shares = val(t, "transactionAcquiredDisposedCode") === "D" ? -n : n;
    const p = Number(val(t, "transactionPricePerShare"));
    const price = Number.isFinite(p) && p > 0 ? p : undefined;
    out.push({ ticker, owner, title, date, code, shares, price, value: price === undefined ? undefined : Math.abs(shares) * price, url });
  }
  return out;
}

/** Recent Form 4 filings (accession + raw XML document name) from a `submissions/CIK….json` body, newest first. */
export function recentForm4(submissions: any, limit: number): { accession: string; doc: string; filed: string }[] {
  const r = submissions?.filings?.recent;
  if (!r?.form) return [];
  const rows: { accession: string; doc: string; filed: string }[] = [];
  for (let i = 0; i < r.form.length && rows.length < limit; i++) {
    if (r.form[i] !== "4") continue;
    // primaryDocument is the XSL-rendered view ("xslF345X05/x.xml"); the raw XML is the same name without the folder
    rows.push({ accession: r.accessionNumber[i], doc: String(r.primaryDocument[i]).replace(/^.*\//, ""), filed: r.filingDate[i] });
  }
  return rows;
}
