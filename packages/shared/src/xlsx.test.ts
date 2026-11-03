import { expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { readXlsx } from "./xlsx";
import { makeXlsx } from "./xlsxTestUtil";

const u16 = (n: number) => [n & 255, (n >> 8) & 255];
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

/** a one-file zip whose file is deflated, declaring `declared` as its size (the declared size can lie, which is the point) */
function zipOf(name: string, data: Uint8Array, declared: number): Uint8Array {
  const packed = deflateRawSync(data);
  const nm = new TextEncoder().encode(name);
  const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(0), ...u32(packed.length), ...u32(declared), ...u16(nm.length), ...u16(0), ...nm];
  const central = [...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(0), ...u32(packed.length), ...u32(declared), ...u16(nm.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...nm];
  const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(central.length), ...u32(local.length + packed.length), ...u16(0)];
  return Uint8Array.from([...local, ...packed, ...central, ...eocd]);
}

test("a zip bomb is refused while inflating, however small the file and whatever size it declares", async () => {
  const zeros = new Uint8Array(100 * 1024 * 1024); // 100 MB of nothing deflates to about 100 KB
  const bomb = zipOf("xl/workbook.xml", zeros, 1000); // declares 1 KB
  expect(bomb.length).toBeLessThan(1024 * 1024);
  await expect(readXlsx(bomb)).rejects.toThrow("inflates to far more");
});

test("a real workbook still reads", async () => {
  const sheets = await readXlsx(makeXlsx([{ name: "P&L", rows: [["a", 1], [null, "b"]] }]));
  expect(sheets[0].name).toBe("P&L");
  expect(sheets[0].rows[0]).toEqual(["a", 1]);
});
