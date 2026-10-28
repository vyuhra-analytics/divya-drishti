// Test helper: builds a small .xlsx (a stored, uncompressed zip with the three XML parts a reader needs) from rows of values, so the tests never need a real
// statement file. Not used by the app.
import type { Sheet } from "./xlsx";

const enc = new TextEncoder();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function crc32(b: Uint8Array): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
const letters = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function makeXlsx(sheets: Sheet[]): Uint8Array {
  const files: [string, string][] = [];
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`;
  files.push(["xl/workbook.xml", workbook], ["xl/_rels/workbook.xml.rels", rels]);
  sheets.forEach((s, i) => {
    const rows = s.rows
      .map((r, ri) => {
        const cells = r
          .map((v, ci) => (v === null || v === undefined ? "" : typeof v === "number" ? `<c r="${letters(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${letters(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`))
          .join("");
        return cells ? `<row r="${ri + 1}">${cells}</row>` : "";
      })
      .join("");
    files.push([`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`]);
  });
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const w32 = (v: DataView, o: number, n: number) => v.setUint32(o, n, true);
  const w16 = (v: DataView, o: number, n: number) => v.setUint16(o, n, true);
  for (const [name, content] of files) {
    const n = enc.encode(name);
    const d = enc.encode(content);
    const crc = crc32(d);
    const lh = new DataView(new ArrayBuffer(30));
    w32(lh, 0, 0x04034b50);
    w16(lh, 4, 20);
    w32(lh, 14, crc);
    w32(lh, 18, d.length);
    w32(lh, 22, d.length);
    w16(lh, 26, n.length);
    const local = new Uint8Array(30 + n.length + d.length);
    local.set(new Uint8Array(lh.buffer), 0);
    local.set(n, 30);
    local.set(d, 30 + n.length);
    parts.push(local);
    const ch = new DataView(new ArrayBuffer(46));
    w32(ch, 0, 0x02014b50);
    w16(ch, 4, 20);
    w16(ch, 6, 20);
    w32(ch, 16, crc);
    w32(ch, 20, d.length);
    w32(ch, 24, d.length);
    w16(ch, 28, n.length);
    w32(ch, 42, offset);
    const cen = new Uint8Array(46 + n.length);
    cen.set(new Uint8Array(ch.buffer), 0);
    cen.set(n, 46);
    central.push(cen);
    offset += local.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  w32(end, 0, 0x06054b50);
  w16(end, 8, files.length);
  w16(end, 10, files.length);
  w32(end, 12, cdSize);
  w32(end, 16, offset);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...parts, ...central, new Uint8Array(end.buffer)]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
