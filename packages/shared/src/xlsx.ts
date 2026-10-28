// A small reader for .xlsx workbooks (a zip of XML files), enough for the statements brokers export: sheet names, rows, and cell values as text or numbers.
// No dependency: the zip directory is read by hand and each file inflated with the platform's DecompressionStream (Bun and every browser have it).
// It reads values only: formulas, styles, merged cells and images are ignored, and a cell holding a date comes back as the spreadsheet's serial number.

export type XlsxCell = string | number | null;
export interface Sheet {
  name: string;
  /** rows[r][c] is the cell in row r+1, column c+1 (0-based indexes); empty cells are null; rows keep their position, so blank rows are empty arrays */
  rows: XlsxCell[][];
}

const MAX_FILE = 30 * 1024 * 1024; // a statement is well under this; a bigger file is not one
const decoder = new TextDecoder("utf-8");

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

interface Entry {
  name: string;
  method: number;
  size: number;
  csize: number;
  offset: number;
}

/** The files of a zip archive, from its central directory. */
function zipEntries(b: Uint8Array): Entry[] {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not an .xlsx file: no zip directory found");
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(b, p) !== 0x02014b50) throw new Error("not an .xlsx file: damaged zip directory");
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    out.push({ method: u16(b, p + 10), csize: u32(b, p + 20), size: u32(b, p + 24), offset: u32(b, p + 42), name: decoder.decode(b.subarray(p + 46, p + 46 + nameLen)) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fileOf(b: Uint8Array, e: Entry): Promise<Uint8Array> {
  if (u32(b, e.offset) !== 0x04034b50) throw new Error("not an .xlsx file: damaged zip entry");
  const start = e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28);
  const data = b.subarray(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflate(data);
  throw new Error(`not an .xlsx file: unsupported zip compression ${e.method}`);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === "#") return String.fromCodePoint(g[1].toLowerCase() === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
    return ENTITIES[g.toLowerCase()] ?? m;
  });

/** The text of every <t> element inside an XML fragment, joined (rich text splits a string over several). */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join("");

/** "B15" to column index 1 ("A" = 0, "AA" = 26). */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml: string, strings: string[]): XlsxCell[][] {
  const rows: XlsxCell[][] = [];
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const attrs = r[1];
    const body = r[2] ?? "";
    const rowNo = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? rows.length + 1);
    const cells: XlsxCell[] = [];
    for (const c of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = c[1];
      const inner = c[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(ca)?.[1];
      if (!ref) continue;
      const type = /\bt="([^"]+)"/.exec(ca)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value: XlsxCell = null;
      if (type === "inlineStr") value = textOf(inner) || null;
      else if (v !== undefined) {
        if (type === "s") value = strings[Number(v)] ?? null;
        else if (type === "str" || type === "e") value = unescapeXml(v);
        else if (type === "b") value = v === "1" ? 1 : 0;
        else {
          const n = Number(v);
          value = Number.isFinite(n) ? n : unescapeXml(v);
        }
      }
      cells[colIndex(ref)] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
    rows[rowNo - 1] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (rows[i] === undefined) rows[i] = [];
  return rows;
}

/** Every sheet of a workbook, in workbook order. Throws a plain-language Error when the bytes are not a workbook this reader understands. */
export async function readXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  if (bytes.length === 0) throw new Error("the file is empty");
  if (bytes.length > MAX_FILE) throw new Error("the file is too big to be a statement");
  const entries = zipEntries(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const text = async (name: string) => {
    const e = byName.get(name);
    return e ? decoder.decode(await fileOf(bytes, e)) : undefined;
  };
  const workbook = await text("xl/workbook.xml");
  if (!workbook) throw new Error("not an .xlsx file: no workbook found (an old .xls file must be saved as .xlsx first)");
  const rels = (await text("xl/_rels/workbook.xml.rels")) ?? "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sst = await text("xl/sharedStrings.xml");
  const strings = sst ? [...sst.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => textOf(m[1] ?? "")) : [];
  const out: Sheet[] = [];
  for (const s of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = unescapeXml(/\bname="([^"]*)"/.exec(s[1])?.[1] ?? "");
    const rid = /\br:id="([^"]+)"/.exec(s[1])?.[1];
    const path = rid ? targets.get(rid) : undefined;
    const xml = path ? await text(path) : undefined;
    if (xml === undefined) continue;
    out.push({ name, rows: parseSheet(xml, strings) });
  }
  return out;
}
