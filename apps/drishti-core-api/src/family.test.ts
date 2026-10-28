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
  test("not a workbook, an unknown report and a file for the wrong broker each say so", async () => {
    const { svc, dad, acc } = await setup();
    await expect(svc.importFile(acc.id, "a.xlsx", new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.importFile(acc.id, "a.xlsx", makeXlsx([{ name: "x", rows: [["hello"]] }]))).rejects.toThrow(/neither a Zerodha/);
    const kotak = await svc.addAccount({ memberId: dad.id, broker: "kotak", label: "k" });
    await expect(svc.importFile(kotak.id, "a.xlsx", statement())).rejects.toThrow(/Zerodha file, but account .* is a Kotak account/);
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

describe("a Kotak Neo Gain-Loss file", () => {
  const kotak = (client = "KX9999", holder?: string) =>
    makeXlsx([
      {
        name: "Realized Gain-Loss",
        rows: [
          [],
          ["Client Name"],
          ["Client Code", client, null, "Charges", null, 33.25],
          ["Transaction Period", "From : 2024-04-01 To : 2025-03-31", null, "Net P&L", null, 94.52],
          ["Transaction Type", "ALL", null, "Segment Type", null, "Derivatives"],
          [],
          [],
          ["Script Name", "Security Type", "ISIN", "Qty", "Buy Amt. (A)", "Sell Amt. (B)", "Gross Realized P&L", null, null, null, "Charges", null, null, null, null, "Net P&L (T - S)", "Gross P&L (T + (C + D + E))"],
          [null, null, null, null, null, null, "Intraday", "<1yr.", ">1Yr.", "Total\n(T = B - A)", "GST (C)", "Brokerage (D)", "Misc. (E)", "STT/CTT (S)", "Total (C + D + E + S)", null, null],
          ["Derivatives"],
          ["BANKNIFTY 24DEC24 CE 52700", "OPTIDX", "-", 15, 1000, 1100, "-", 100, "NA", 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77],
          ["Derivatives Total", "", "", 15, 1000, 1100, 0, 100, 0, 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77],
        ] as never,
      },
      ...(holder ? [{ name: "P&L Equity-Tradewise", rows: [[], ["Client Name", holder]] as never }] : []),
    ]);

  test("creates a Kotak account for its client id, with the gross result and the charges, and a repeat is refused", async () => {
    const store = new MemStore();
    const svc = new FamilyService(store);
    const r = await svc.importFile(undefined, "Gain_Loss_KX9999.xlsx", kotak());
    expect(r).toMatchObject({ kind: "pnl", newAccount: true, rows: 1 });
    expect(store.a[0]).toMatchObject({ broker: "kotak", clientCode: "KX9999" });
    expect(store.i[0].summary).toMatchObject({ realized: 127.77, charges: 33.25 });
    await expect(svc.importFile(undefined, "again.xlsx", kotak())).rejects.toThrow(/already imported/);
  });

  test("a Kotak file never lands in a Zerodha account, even one named explicitly", async () => {
    const { svc, acc } = await setup();
    await expect(svc.importFile(acc.id, "k.xlsx", kotak())).rejects.toThrow(/Kotak file, but account .* is a Zerodha account/);
    // with no account named it finds none for Kotak and creates its own, leaving the Zerodha one alone
    const r = await svc.importFile(undefined, "k.xlsx", kotak());
    expect(r.newAccount).toBe(true);
  });
});

describe("a file that prints the holder's name", () => {
  const kotakNamed = (client: string, holder: string) =>
    makeXlsx([
      { name: "Realized Gain-Loss", rows: [[], ["Client Name"], ["Client Code", client, null, "Charges", null, 33.25], ["Transaction Period", "From : 2024-04-01 To : 2025-03-31", null, "Net P&L", null, 94.52], ["Transaction Type", "ALL", null, "Segment Type", null, "Derivatives"], [], [], ["Script Name", "Security Type", "ISIN", "Qty", "Buy Amt. (A)", "Sell Amt. (B)", "Gross Realized P&L", null, null, null, "Charges", null, null, null, null, "Net P&L (T - S)", "Gross P&L (T + (C + D + E))"], [null, null, null, null, null, null, "Intraday", "<1yr.", ">1Yr.", "Total (T = B - A)", "GST (C)", "Brokerage (D)", "Misc. (E)", "STT/CTT (S)", "Total (C + D + E + S)", null, null], ["Derivatives"], ["BANKNIFTY 24DEC24 CE 52700", "OPTIDX", "-", 15, 1000, 1100, "-", 100, "NA", 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77], ["Derivatives Total", "", "", 15, 1000, 1100, 0, 100, 0, 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77]] as never },
      { name: "P&L Equity-Tradewise", rows: [[], ["Client Name", holder]] as never },
    ]);

  test("goes under the member of that name (case and spacing ignored) and creates no Unassigned member", async () => {
    const store = new MemStore();
    const svc = new FamilyService(store);
    const priya = await svc.addMember({ nickname: "Priya Sharma" });
    const r = await svc.importFile(undefined, "k.xlsx", kotakNamed("KX9999", "PRIYA   SHARMA"));
    expect(r).toMatchObject({ newAccount: true, filedUnder: "Priya Sharma" });
    expect(store.a[0].memberId).toBe(priya.id);
    expect(store.m).toHaveLength(1);
  });

  test("a name that matches no member, or two members, still creates an Unassigned member for the owner to name", async () => {
    const store = new MemStore();
    const svc = new FamilyService(store);
    await svc.addMember({ nickname: "Someone Else" });
    const r = await svc.importFile(undefined, "k.xlsx", kotakNamed("KX9999", "PRIYA SHARMA"));
    expect(r.filedUnder).toBeUndefined();
    expect(store.m.map((m) => m.nickname)).toEqual(["Someone Else", "Unassigned 1"]);
    // the name is compared, never stored
    expect(JSON.stringify(store.a) + JSON.stringify(store.i)).not.toMatch(/PRIYA/i);
  });
});

describe("moving an account to a member who has one of the same name", () => {
  test("keeps the move and tells the two apart, so an Unassigned member can always be emptied and removed", async () => {
    const store = new MemStore();
    const svc = new FamilyService(store);
    const a = await svc.addMember({ nickname: "Priya" });
    const b = await svc.addMember({ nickname: "Unassigned 1" });
    await svc.addAccount({ memberId: a.id, broker: "zerodha", label: "Zerodha account" });
    const k = await svc.addAccount({ memberId: b.id, broker: "kotak", label: "Kotak account" });
    const same = await svc.addAccount({ memberId: b.id, broker: "zerodha", label: "Zerodha account" });
    const moved = await svc.updateAccount(same.id, { memberId: a.id });
    expect(moved).toMatchObject({ memberId: a.id, label: "Zerodha account (Zerodha)" });
    expect((await svc.updateAccount(k.id, { memberId: a.id })).label).toBe("Kotak account"); // no clash, no change
    await svc.deleteMember(b.id);
    expect(store.m.map((m) => m.nickname)).toEqual(["Priya"]);
    // an explicit new label that clashes is still refused
    await expect(svc.updateAccount(k.id, { label: "Zerodha account" })).rejects.toBeInstanceOf(ConflictException);
  });
  test("a file's new account is labelled by its broker", async () => {
    const store = new MemStore();
    await new FamilyService(store).importFile(undefined, "a.xlsx", statement());
    expect(store.a[0].label).toBe("Zerodha account");
  });
});

describe("a Kotak file with several segments", () => {
  const head = [
    [],
    ["Client Name"],
    ["Client Code", "KX9999", null, "Charges", null, 78],
    ["Transaction Period", "From : 2024-04-01 To : 2025-03-31", null, "Net P&L", null, 143.77],
    ["Transaction Type", "ALL", null, "Segment Type", null, "Derivatives, Commodity"],
    [],
    [],
    ["Script Name", "Security Type", "ISIN", "Qty", "Buy Amt. (A)", "Sell Amt. (B)", "Gross Realized P&L", null, null, null, "Charges", null, null, null, null, "Net P&L (T - S)", "Gross P&L (T + (C + D + E))"],
    [null, null, null, null, null, null, "Intraday", "<1yr.", ">1Yr.", "Total (T = B - A)", "GST (C)", "Brokerage (D)", "Misc. (E)", "STT/CTT (S)", "Total (C + D + E + S)", null, null],
  ];
  const both = (over: { derivOnly?: boolean } = {}) =>
    makeXlsx([
      {
        name: "Realized Gain-Loss",
        rows: [
          ...head,
          ["Derivatives"],
          ["BANKNIFTY 24DEC24 CE 52700", "OPTIDX", "-", 15, 1000, 1100, "-", 100, "NA", 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77],
          ["Derivatives Total", "", "", 15, 1000, 1100, 0, 100, 0, 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77],
          ["Commodity"],
          ["CRUDEOIL 15NOV24 CE 5900", "OPTFUT", "-", 100, 12000, 12060, "-", 60, "NA", 60, 4, 20, 10, 10.75, 44.75, 49.25, 94],
          ["Commodity Total", "", "", 100, 12000, 12060, 0, 60, 0, 60, 4, 20, 10, 10.75, 44.75, 49.25, 94],
          [],
          ["Grand Total"],
          ["Disclaimer"],
        ] as never,
      },
    ]);

  test("is stored as one statement per segment under one account, and a repeat is refused", async () => {
    const store = new MemStore();
    const svc = new FamilyService(store);
    const r = await svc.importFile(undefined, "all.xlsx", both());
    expect(r).toMatchObject({ newAccount: true, segment: "fno", segments: ["fno", "commodity"], rows: 2 });
    expect(r.summary).toMatchObject({ realized: 221.77, charges: 78 });
    expect(store.i.map((i) => [i.segment, i.accountId])).toEqual([["fno", store.a[0].id], ["commodity", store.a[0].id]]);
    expect(store.i[0].hash).not.toBe(store.i[1].hash);
    await expect(svc.importFile(undefined, "again.xlsx", both())).rejects.toThrow(/already imported/);
    expect(store.i).toHaveLength(2);
  });

  test("taken whole or not at all: an overlap in one segment stops the others being stored", async () => {
    const store = new MemStore();
    const svc = new FamilyService(store);
    await svc.importFile(undefined, "derivs.xlsx", makeXlsx([{ name: "Realized Gain-Loss", rows: [...head, ["Derivatives"], ["BANKNIFTY 24DEC24 CE 52700", "OPTIDX", "-", 15, 1000, 1100, "-", 100, "NA", 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77], ["Derivatives Total", "", "", 15, 1000, 1100, 0, 100, 0, 100, 3.6, 20, 4.17, 5.48, 33.25, 94.52, 127.77], ["Disclaimer"]] as never }]), { accept: true });
    const before = store.i.length;
    await expect(svc.importFile(undefined, "all.xlsx", both(), { accept: true })).rejects.toThrow(/Futures & Options.*overlaps derivs.xlsx/);
    expect(store.i).toHaveLength(before);
  });
});

describe("what the screen reads beyond the totals", () => {
  test("the summary carries every contract, the insights and the two cross-tables; the overview carries the coverage", async () => {
    const { svc, acc } = await setup();
    await svc.importFile(acc.id, "a.xlsx", statement());
    const s = await svc.summary({});
    expect(s.contracts).toHaveLength(1);
    expect(s.contractsTotal).toBe(1);
    expect(s.contracts[0]).toMatchObject({ symbol: "NIFTY2462023600CE", underlying: "NIFTY", segment: "fno", realized: 700 });
    expect(s.insights).toMatchObject({ contracts: 1, winners: 1, losers: 0 });
    expect(s.yearBySegment.cols.map((c) => c.key)).toEqual(["fno"]);
    expect(s.memberByYear.rows).toHaveLength(1);
    const o = await svc.overview();
    expect(o.coverage.years).toEqual(["2024-25"]);
    expect(o.statementPeriods).toEqual(["2024-25"]);
    expect(o.coverage.rows[0].cells["2024-25"]).toMatchObject({ statements: ["fno"], tradebook: false, partial: true });
  });

  test("no insights for an empty selection", async () => {
    const { svc } = await setup();
    const s = await svc.summary({});
    expect(s.insights).toBeNull();
    expect(s.contracts).toEqual([]);
  });

  test("the accountant's statement needs a member and a financial year, and says so when there is none", async () => {
    const { svc, acc, dad } = await setup();
    await svc.importFile(acc.id, "a.xlsx", statement("AB1234", 700, "2025-03-31", "2024-04-01"));
    await expect(svc.statement(undefined, "2024-25")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.statement(dad.id, "2024")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.statement(999, "2024-25")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.statement(dad.id, "2019-20")).rejects.toBeInstanceOf(NotFoundException);
    const st = await svc.statement(dad.id, "2024-25");
    expect(st).toMatchObject({ fy: "2024-25", totals: { realized: 700, chargesTotal: 30, net: 670 } });
    expect(JSON.stringify(st)).not.toContain("AB1234"); // the client id only ever appears masked
  });
});
