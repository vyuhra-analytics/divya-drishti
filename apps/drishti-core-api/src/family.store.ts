import type { FamilyAccount, FamilyMember, ImportRecord } from "@drishti/shared";
import type { Db } from "./db";
import type { FamilyStore } from "./family.service";

// Postgres behind FamilyService (infra/sql/027_family.sql). jsonb goes in as text then ::jsonb, the way the rest of the app does it under Bun.
export class PgFamilyStore implements FamilyStore {
  constructor(private readonly db: Db) {}
  private get sql() {
    return this.db.sql;
  }

  async members() {
    return (await this.sql`SELECT id, nickname, relation, hidden, note FROM family_members ORDER BY id`) as FamilyMember[];
  }
  async accounts() {
    return ((await this.sql`SELECT id, member_id, broker, label, client_code FROM family_accounts ORDER BY id`) as any[]).map((r) => ({ id: r.id, memberId: r.member_id, broker: r.broker, label: r.label, clientCode: r.client_code }) as FamilyAccount);
  }
  async imports() {
    const rows = (await this.sql`SELECT id, account_id, kind, segment, to_char(period_from, 'YYYY-MM-DD') AS period_from, to_char(period_to, 'YYYY-MM-DD') AS period_to, file_name, imported_at, payload FROM family_imports ORDER BY id`) as any[];
    return rows.map((r) => {
      const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
      return { id: r.id, accountId: r.account_id, kind: r.kind, segment: r.segment, periodFrom: r.period_from, periodTo: r.period_to, fileName: r.file_name, importedAt: new Date(r.imported_at).toISOString(), summary: p.summary, lines: p.lines ?? [], charges: p.charges ?? [], fills: p.fills ?? [], problems: p.problems ?? [] } as ImportRecord;
    });
  }
  async addMember(m: Omit<FamilyMember, "id">) {
    const [r] = (await this.sql`INSERT INTO family_members (nickname, relation, hidden, note) VALUES (${m.nickname}, ${m.relation}, ${m.hidden}, ${m.note}) RETURNING id, nickname, relation, hidden, note`) as FamilyMember[];
    return r;
  }
  async updateMember(id: number, patch: Partial<Omit<FamilyMember, "id">>) {
    const cur = (await this.members()).find((m) => m.id === id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch };
    await this.sql`UPDATE family_members SET nickname = ${n.nickname}, relation = ${n.relation}, hidden = ${n.hidden}, note = ${n.note} WHERE id = ${id}`;
    return n;
  }
  async deleteMember(id: number) {
    await this.sql`DELETE FROM family_members WHERE id = ${id}`;
  }
  async addAccount(a: Omit<FamilyAccount, "id">) {
    const [r] = (await this.sql`INSERT INTO family_accounts (member_id, broker, label, client_code) VALUES (${a.memberId}, ${a.broker}, ${a.label}, ${a.clientCode}) RETURNING id`) as { id: number }[];
    return { id: r.id, ...a };
  }
  async updateAccount(id: number, patch: Partial<Pick<FamilyAccount, "memberId" | "label" | "clientCode">>) {
    const cur = (await this.accounts()).find((a) => a.id === id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch };
    await this.sql`UPDATE family_accounts SET member_id = ${n.memberId}, label = ${n.label}, client_code = ${n.clientCode} WHERE id = ${id}`;
    return n;
  }
  async deleteAccount(id: number) {
    await this.sql`DELETE FROM family_accounts WHERE id = ${id}`;
  }
  async addImport(r: Omit<ImportRecord, "id" | "importedAt"> & { fileHash: string }) {
    const payload = JSON.stringify({ summary: r.summary, lines: r.lines, charges: r.charges, fills: r.fills, problems: r.problems });
    const [row] = (await this.sql`INSERT INTO family_imports (account_id, kind, segment, period_from, period_to, file_name, file_hash, payload)
      VALUES (${r.accountId}, ${r.kind}, ${r.segment}, ${r.periodFrom}, ${r.periodTo}, ${r.fileName}, ${r.fileHash}, ${payload}::text::jsonb) RETURNING id, imported_at`) as { id: number; imported_at: string }[];
    const { fileHash: _h, ...rest } = r;
    return { ...rest, id: row.id, importedAt: new Date(row.imported_at).toISOString() } as ImportRecord;
  }
  async hasHash(accountId: number, hash: string) {
    return ((await this.sql`SELECT 1 FROM family_imports WHERE account_id = ${accountId} AND file_hash = ${hash}`) as unknown[]).length > 0;
  }
  async deleteImport(id: number) {
    return ((await this.sql`DELETE FROM family_imports WHERE id = ${id} RETURNING id`) as unknown[]).length > 0;
  }
}
