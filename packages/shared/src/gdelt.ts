// GDELT Global Knowledge Graph (GKG) 15-minute files, read for crude-oil headlines (research/sentiment, deviation D1 in PREREGISTRATION.md).
// GDELT is free and open and must be credited: https://www.gdeltproject.org. NOT re-exported from index.ts: it uses node:zlib, so the browser bundle never sees it.
// Pure parsing and filtering; scripts/gdelt-backfill.ts does the downloading and storing.
import { inflateRawSync } from "node:zlib";

const BATCH_MS = 15 * 60_000;

/** The 15-minute batch times in [from, to), UTC ms, on the quarter hour. */
export function batchTimes(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(from / BATCH_MS) * BATCH_MS; t < to; t += BATCH_MS) out.push(t);
  return out;
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);

/** `https://data.gdeltproject.org/gdeltv2/20260601003000.gkg.csv.zip` (the http address redirects to https). */
export const gkgUrl = (batch: number) => `https://data.gdeltproject.org/gdeltv2/${stamp(batch)}.gkg.csv.zip`;

/** The text of the first (only) entry of a zip file, read from its central directory so entry sizes that sit after the data are known. */
export function unzipFirstEntry(buf: Uint8Array): string {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  const cd = b.readUInt32LE(eocd + 16);
  if (b.readUInt32LE(cd) !== 0x02014b50) throw new Error("zip central directory not found");
  const method = b.readUInt16LE(cd + 10);
  const compressed = b.readUInt32LE(cd + 20);
  const local = b.readUInt32LE(cd + 42);
  if (b.readUInt32LE(local) !== 0x04034b50) throw new Error("zip entry header not found");
  const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
  const data = b.subarray(start, start + compressed);
  if (method === 0) return data.toString("utf8");
  if (method === 8) return inflateRawSync(data).toString("utf8");
  throw new Error(`zip method ${method} is not supported`);
}

export interface GkgRow {
  id: string;
  /** the GDELT batch time of the row (when GDELT processed the article), UTC ms */
  at: number;
  source: string;
  url: string;
  themes: string;
  title?: string;
}

/** `20260601003000` to epoch ms (UTC). */
function parseStamp(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** Entities in a page title: the named basics and numeric ones (`&#x2013;`, `&#39;`). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === "#") {
      const code = g[1].toLowerCase() === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

/** Rows of one GKG file (27 tab-separated columns: 0 id, 1 date, 3 source, 4 url, 7 themes, 26 extras holding `<PAGE_TITLE>`). Short or undated rows are skipped. */
export function parseGkg(text: string): GkgRow[] {
  const out: GkgRow[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    if (f.length < 27) continue;
    const at = parseStamp(f[1]);
    if (!Number.isFinite(at)) continue;
    const t = /<PAGE_TITLE>([\s\S]*?)<\/PAGE_TITLE>/.exec(f[26]);
    out.push({ id: f[0], at, source: f[3], url: f[4], themes: f[7], title: t ? decodeEntities(t[1]).replace(/\s+/g, " ").trim() : undefined });
  }
  return out;
}

/**
 * THE RELEVANCE RULE (fixed before any data was fetched; deviation D1 in PREREGISTRATION.md; a change adds a trial to the counter): a title is a crude-market
 * headline when it names the oil market or a crude benchmark and is not about another kind of oil. Titles only: the GKG themes are stored, not used.
 */
export const CRUDE_TERMS =
  /\b(crude|brent|wti|west texas|opec\+?|oil (?:prices?|futures|market|markets|supply|supplies|demand|output|production|inventories|stocks|stockpiles|exports?|imports?|tankers?|flows?|rally|slump|surge|jumps?|falls?|drops?|rises?|slides?|gains?|rebounds?|settles?|extends|steadies|holds)|oil[- ](?:price|prices)|prices? of oil|petroleum|barrel|refiner(?:y|ies)|strait of hormuz|hormuz|shale|rig count|eia|energy prices|fuel prices|gasoline prices|diesel prices|sanctions on (?:russian|iranian|venezuelan) oil|russian oil|iranian oil|venezuelan oil|saudi (?:oil|aramco)|aramco)\b/i;

export const NONCRUDE_TERMS =
  /\b(olive|palm|coconut|cooking|essential|sunflower|vegetable|fish|baby|massage|hair|skin|body|motor oil|engine oil|lubricants?|oil paint(?:ing|s)?|snake oil|cbd|hemp|castor|argan|tea tree|fryer|frying|canola|soybean|soya|mustard|sesame|avocado|cannabis|aromatherapy|diffuser|sunscreen|cosmetic|recipe|restaurant|menu)\b/i;

export const isCrudeTitle = (title: string) => CRUDE_TERMS.test(title) && !NONCRUDE_TERMS.test(title);

/**
 * The key two copies of the same headline share: lower case, a short publisher suffix (" - Reuters", " | Bloomberg") cut off, anything that is not a letter or a
 * digit gone. The earliest batch holding a key is the event; later copies are dropped.
 */
export function titleKey(title: string): string {
  const cut = title.replace(/\s+[-|–—]\s+[^-|–—]{1,40}$/, "");
  return cut
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface Headline {
  key: string;
  at: number;
  source: string;
  url: string;
  title: string;
  themes: string;
}

/** The crude headlines of one file, one per key (the first row of the file for a key), in file order. */
export function extractHeadlines(text: string): Headline[] {
  const seen = new Set<string>();
  const out: Headline[] = [];
  for (const r of parseGkg(text)) {
    if (!r.title || r.title.length < 15 || !isCrudeTitle(r.title)) continue;
    const key = titleKey(r.title);
    if (key.length < 10 || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, at: r.at, source: r.source, url: r.url, title: r.title, themes: r.themes });
  }
  return out;
}
