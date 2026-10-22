import type { SQL } from "bun";
import { currentRates, MAX_TRADES_KEPT, UPSTOX_MCX_RATES, type AccountRow, type AuditEntry, type CostRates, type PaperPosition, type PaperStore, type PaperTrade } from "@drishti/shared";

/** Postgres-backed paper account storage (tables in infra/sql/006_paper.sql). jsonb goes in as text first: Bun sends a string param cast straight to jsonb as a JSON string. */
export class PgPaperStore implements PaperStore {
  constructor(private readonly sql: SQL) {}

  async listAccounts() {
    return (await this.sql`SELECT id, capital, slippage FROM paper_accounts ORDER BY created_at, id`) as AccountRow[];
  }

  async getAccount(id: string) {
    const r = (await this.sql`SELECT id, capital, slippage FROM paper_accounts WHERE id = ${id}`) as AccountRow[];
    return r[0];
  }

  async saveAccount(a: AccountRow) {
    await this.sql`INSERT INTO paper_accounts (id, capital, slippage) VALUES (${a.id}, ${a.capital}, ${a.slippage}) ON CONFLICT (id) DO UPDATE SET capital = EXCLUDED.capital, slippage = EXCLUDED.slippage`;
  }

  async deleteAccount(id: string) {
    await this.sql`DELETE FROM paper_accounts WHERE id = ${id}`; // positions and trades go with it (ON DELETE CASCADE)
  }

  async positions(account: string) {
    return ((await this.sql`SELECT data FROM paper_positions WHERE account = ${account} ORDER BY opened_at`) as { data: PaperPosition }[]).map((r) => r.data);
  }

  async allPositions() {
    return ((await this.sql`SELECT account, data FROM paper_positions`) as { account: string; data: PaperPosition }[]).map((r) => ({ account: r.account, position: r.data }));
  }

  async savePosition(account: string, p: PaperPosition) {
    await this.sql`INSERT INTO paper_positions (id, account, data, opened_at) VALUES (${p.id}, ${account}, ${JSON.stringify(p)}::text::jsonb, to_timestamp(${p.openedAt / 1000}))
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
  }

  async deletePosition(account: string, id: string) {
    await this.sql`DELETE FROM paper_positions WHERE id = ${id} AND account = ${account}`;
  }

  async trades(account: string, limit: number) {
    return ((await this.sql`SELECT data FROM paper_trades WHERE account = ${account} ORDER BY closed_at DESC, id DESC LIMIT ${limit}`) as { data: PaperTrade }[]).map((r) => r.data);
  }

  async saveTrade(account: string, t: PaperTrade) {
    await this.sql`INSERT INTO paper_trades (id, account, data, closed_at) VALUES (${t.id}, ${account}, ${JSON.stringify(t)}::text::jsonb, to_timestamp(${t.closedAt / 1000}))
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
    // keep the journal bounded: the newest MAX_TRADES_KEPT per account
    await this.sql`DELETE FROM paper_trades WHERE account = ${account} AND id NOT IN (SELECT id FROM paper_trades WHERE account = ${account} ORDER BY closed_at DESC, id DESC LIMIT ${MAX_TRADES_KEPT})`;
  }

  async setNote(account: string, tradeId: string, note: string) {
    const r = (await this.sql`UPDATE paper_trades SET data = jsonb_set(data, '{note}', to_jsonb(${note}::text)) WHERE id = ${tradeId} AND account = ${account} RETURNING id`) as unknown[];
    return r.length > 0;
  }

  async reset(account: string) {
    await this.sql`DELETE FROM paper_positions WHERE account = ${account}`;
    await this.sql`DELETE FROM paper_trades WHERE account = ${account}`;
  }

  async ordersSince(account: string, actor: string, sinceMs: number) {
    const r = (await this.sql`SELECT count(*)::int AS n FROM paper_audit WHERE account = ${account} AND actor = ${actor} AND action = 'place' AND ok AND at >= to_timestamp(${sinceMs / 1000})`) as { n: number }[];
    return r[0]?.n ?? 0;
  }

  async audit(e: AuditEntry) {
    await this.sql`INSERT INTO paper_audit (at, actor, action, account, args, ok, detail) VALUES (to_timestamp(${e.at / 1000}), ${e.actor}, ${e.action}, ${e.account}, ${JSON.stringify(e.args ?? null)}::text::jsonb, ${e.ok}, ${e.detail.slice(0, 500)})`;
  }

  /** The cost rates the user saved (Costs panel); the Upstox defaults when none. */
  async rates(): Promise<CostRates> {
    const r = (await this.sql`SELECT value FROM kv WHERE key = 'cost_rates'`) as { value: string }[];
    try {
      return r[0] ? currentRates({ ...UPSTOX_MCX_RATES, ...JSON.parse(r[0].value) }) : UPSTOX_MCX_RATES;
    } catch {
      return UPSTOX_MCX_RATES;
    }
  }

  async saveRates(rates: CostRates) {
    await this.sql`INSERT INTO kv (key, value) VALUES ('cost_rates', ${JSON.stringify(rates)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  }
}
