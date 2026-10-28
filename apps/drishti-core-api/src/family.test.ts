import { describe, expect, test } from "bun:test";
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { FamilyAccount, FamilyMember, ImportRecord } from "@drishti/shared";
import { makeXlsx } from "../../../packages/shared/src/xlsxTestUtil";
import { FamilyService, type FamilyStore } from "./family.service";

class MemStore implements FamilyStore {
  m: FamilyMember[] = [];
  a: FamilyAccount[] = [];
  i: (ImportRecord & { hash: string })[] = [];
  n = 0;
  async members() { return this.m; }
  async accounts() { return this.a; }
  async imports() { return this.i; }
  async addMember(x: Omit<FamilyMember, "id">) { const r = { id: ++this.n, ...x }; this.m.push(r); return r; }
  async updateMember(id: number, p: Partial<FamilyMember>) { const c = this.m.find((x) => x.id === id); if (!c) return undefined; Object.assign(c, p); return c; }
  async deleteMember(id: number) { this.m = this.m.filter((x) => x.id !== id); }
  async addAccount(x: Omit<FamilyAccount, "id">) { const r = { id: ++this.n, ...x }; this.a.push(r); return r; }
  async updateAccount(id: number, p: Partial<FamilyAccount>) { const c = this.a.find((x) => x.id === id); if (!c) return undefined; Object.assign(c, p); return c; }
  async deleteAccount(id: number) { this.a = this.a.filter((x) => x.id !== id); }
  async addImport(r: any) { const rec = { ...r, id: ++this.n, importedAt: "now", hash: r.fileHash }; this.i.push(rec); return rec; }
  async hasHash(acc: number, h: string) { return this.i.some((x) => x.accountId === acc && x.hash === h); }
  async deleteImport(id: number) { const had = this.i.some((x) => x.id === id); this.i = this.i.filter((x) => x.id !== id); return had; }
}

const statement = (client = "AB1234", realized = 700, to = "2024-10-28", from = "2024-04-01") =>
  makeXlsx([
    {
      name: "F&O",
      rows: [
        [], [], [], [], [], [],
        [null, "Client ID", client],
        [], [], [],
        [null, `P&L Statement for F&O from ${from} to ${to}`],
        [], [null, "Summary"], [],
        [null, "Charges", 30], [null, "Other Credit & Debit", 0], [null, "Realized P&L", realized], [null, "Unrealized P&L", 0],
        [], [], [null, "Charges"], [],
        [null, "Account Head", "Amount"], [null, "Brokerage - Z", 30],
        [], [], [], [], [], [], [], [],
        [null, "Symbol", "ISIN", "Quantity", "Buy Value", "Sell Value", "Realized P&L", "Realized P&L Pct.", "Previous Closing Price", "Open Quantity", "Open Quantity Type", "Open Value", "Unrealized P&L"],
        [null, "NIFTY2462023600CE", null, 25, 1000, 1700, 700, 70, 0, 0, null, 0, 0],
      ],
    },
  ]);

async function setup() {
  const store = new MemStore();
  const svc = new FamilyService(store);
  const dad = await svc.addMember({ nickname: "Dad", relation: "father" });
  const acc = await svc.addAccount({ memberId: dad.id, broker: "zerodha", label: "main" });
  return { store, svc, dad, acc };
}

describe("members and accounts", () => {
  test("a member needs a plain nickname and nicknames are unique", async () => {
    const { svc } = await setup();
    await expect(svc.addMember({ nickname: "" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.addMember({ nickname: "<b>x</b>" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.addMember({ nickname: "dad" })).rejects.toBeInstanceOf(ConflictException);
  });
  test("an account takes a broker client id of plain letters and digits, and two accounts cannot share one", async () => {
    const { svc, dad } = await setup();
    await expect(svc.addAccount({ memberId: dad.id, broker: "zerodha", label: "two", clientCode: "no spaces!" })).rejects.toBeInstanceOf(BadRequestException);
    await svc.addAccount({ memberId: dad.id, broker: "zerodha", label: "two", clientCode: "ab9999" });
    await expect(svc.addAccount({ memberId: dad.id, broker: "zerodha", label: "three", clientCode: "AB9999" })).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.addAccount({ memberId: dad.id, broker: "hdfc", label: "two" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.addAccount({ memberId: 999, broker: "zerodha", label: "two" })).rejects.toBeInstanceOf(NotFoundException);
  });
  test("a member with accounts, and an account with imports, cannot be removed", async () => {
    const { svc, dad, acc } = await setup();
    await expect(svc.deleteMember(dad.id)).rejects.toBeInstanceOf(ConflictException);
    await svc.importFile(acc.id, "a.xlsx", statement());
    await expect(svc.deleteAccount(acc.id)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("importing a statement", () => {
  test("a dry run reads and reports without storing", async () => {
    const { svc, store, acc } = await setup();
    const r = await svc.importFile(acc.id, "a.xlsx", statement(), { dry: true });
    expect(r).toMatchObject({ dry: true, kind: "pnl", segment: "fno", rows: 1, periodFrom: "2024-04-01" });
    expect(store.i).toHaveLength(0);
  });
  test("stores it, remembers the client id, and the same file twice is refused", async () => {
    const { svc, store, acc } = await setup();
    const r = await svc.importFile(acc.id, "a.xlsx", statement());
    expect(r.id).toBeGreaterThan(0);
    expect(store.a[0].clientCode).toBe("AB1234");
    await expect(svc.importFile(acc.id, "a.xlsx", statement())).rejects.toThrow(/already imported/);
  });
  test("a file for another client id is refused", async () => {
    const { svc, acc } = await setup();
    await svc.importFile(acc.id, "a.xlsx", statement("AB1234"));
    await expect(svc.importFile(acc.id, "b.xlsx", statement("ZZ9999", 700, "2025-03-31", "2024-11-01"))).rejects.toBeInstanceOf(ConflictException);
  });
  test("an overlapping period for the same kind and segment is refused, a following one is accepted", async () => {
    const { svc, acc } = await setup();
    await svc.importFile(acc.id, "a.xlsx", statement("AB1234", 700, "2024-10-28"));
    await expect(svc.importFile(acc.id, "b.xlsx", statement("AB1234", 700, "2025-03-31", "2024-10-28"))).rejects.toThrow(/overlaps a.xlsx/);
    await svc.importFile(acc.id, "c.xlsx", statement("AB1234", 700, "2025-03-31", "2024-10-29"));
  });
  test("a statement that does not add up is not stored unless accepted", async () => {
    const { svc, store, acc } = await setup();
    await expect(svc.importFile(acc.id, "a.xlsx", statement("AB1234", 650))).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(store.i).toHaveLength(0);
    const r = await svc.importFile(acc.id, "a.xlsx", statement("AB1234", 650), { accept: true });
    expect(r.problems.length).toBeGreaterThan(0);
    expect(store.i).toHaveLength(1);
  });
  test("not a workbook, an unknown report and a broker with no reader each say so", async () => {
    const { svc, dad, acc } = await setup();
    await expect(svc.importFile(acc.id, "a.xlsx", new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.importFile(acc.id, "a.xlsx", makeXlsx([{ name: "x", rows: [["hello"]] }]))).rejects.toThrow(/neither a Zerodha/);
    const kotak = await svc.addAccount({ memberId: dad.id, broker: "kotak", label: "k" });
    await expect(svc.importFile(kotak.id, "a.xlsx", statement())).rejects.toThrow(/no reader for Kotak/);
    await expect(svc.importFile(999, "a.xlsx", statement())).rejects.toBeInstanceOf(NotFoundException);
  });
  test("the summary rests on the stored statement", async () => {
    const { svc, acc } = await setup();
    await svc.importFile(acc.id, "a.xlsx", statement());
    const s = await svc.summary({});
    expect(s.summary.totals).toMatchObject({ realized: 700, charges: 30, net: 670 });
    expect(s.monthly.withoutTradebook).toHaveLength(1);
  });
});

describe("a file finds its account by client id", () => {
  test("with no account named and none known, an Unassigned member and account are created, and the next file for the same client reuses them", async () => {
    const store = new MemStore();
    const svc = new FamilyService(store);
    const dry = await svc.importFile(undefined, "a.xlsx", statement("PZ0888"), { dry: true });
    expect(dry).toMatchObject({ newAccount: true, account: null, client: "***888" });
    expect(store.m).toHaveLength(0); // a dry run creates nothing
    const first = await svc.importFile(undefined, "a.xlsx", statement("PZ0888"));
    expect(store.m.map((m) => m.nickname)).toEqual(["Unassigned 1"]);
    expect(store.a[0]).toMatchObject({ broker: "zerodha", clientCode: "PZ0888" });
    expect(first.account).not.toBeNull();
    await svc.importFile(undefined, "b.xlsx", statement("PZ0888", 700, "2025-03-31", "2024-10-29"));
    expect(store.m).toHaveLength(1);
    expect(store.i).toHaveLength(2);
    await svc.importFile(undefined, "c.xlsx", statement("PZ0999"));
    expect(store.m.map((m) => m.nickname)).toEqual(["Unassigned 1", "Unassigned 2"]);
  });
  test("an account can be renamed and moved to the right person afterwards", async () => {
    const store = new MemStore();
    const svc = new FamilyService(store);
    await svc.importFile(undefined, "a.xlsx", statement("PZ0888"));
    const mum = await svc.addMember({ nickname: "Mum", relation: "mother" });
    const moved = await svc.updateAccount(store.a[0].id, { memberId: mum.id, label: "Zerodha main" });
    expect(moved).toMatchObject({ memberId: mum.id, label: "Zerodha main" });
    await svc.deleteMember(store.m.find((m) => m.nickname === "Unassigned 1")!.id); // now empty, so it can go
    await expect(svc.updateAccount(store.a[0].id, { memberId: 999 })).rejects.toBeInstanceOf(NotFoundException);
  });
  test("the client id in the error text is masked", async () => {
    const { svc, acc } = await setup();
    await svc.importFile(acc.id, "a.xlsx", statement("AB1234"));
    const err = await svc.importFile(acc.id, "b.xlsx", statement("ZZ9999", 700, "2025-03-31", "2024-11-01")).catch((e) => e);
    expect(err.message).not.toContain("ZZ9999");
    expect(err.message).toContain("***999");
  });
});

test("main.ts imports nothing at run time that the API does not depend on directly (express broke startup once: every route answered 500 through the proxy)", async () => {
  const main = await Bun.file(new URL("./main.ts", import.meta.url)).text();
  const runtime = [...main.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]).filter((m) => !m.startsWith(".") && !m.startsWith("@drishti/"));
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const m of runtime) expect(Object.keys(deps).includes(m) || m === "reflect-metadata").toBe(true);
});
