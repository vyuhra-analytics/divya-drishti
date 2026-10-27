// An in-memory PaperStore for tests of the paper engine (no database).
import type { PaperPosition, PaperTrade, PendingOrder } from "./paper";
import type { AccountRow, AuditEntry, PaperStore } from "./paperServer";

export class FakeStore implements PaperStore {
  accounts = new Map<string, AccountRow>([["main", { id: "main", capital: 500_000, slippage: 1 }]]);
  pos = new Map<string, { account: string; position: PaperPosition }>();
  tr: { account: string; trade: PaperTrade }[] = [];
  waiting = new Map<string, { account: string; order: PendingOrder }>();
  log: AuditEntry[] = [];
  async listAccounts() {
    return [...this.accounts.values()];
  }
  async getAccount(id: string) {
    return this.accounts.get(id);
  }
  async saveAccount(a: AccountRow) {
    this.accounts.set(a.id, a);
  }
  async deleteAccount(id: string) {
    this.accounts.delete(id);
    await this.reset(id);
  }
  async positions(account: string) {
    return [...this.pos.values()].filter((x) => x.account === account).map((x) => x.position);
  }
  async allPositions() {
    return [...this.pos.values()];
  }
  async savePosition(account: string, p: PaperPosition) {
    this.pos.set(p.id, { account, position: p });
  }
  async deletePosition(_account: string, id: string) {
    this.pos.delete(id);
  }
  async pendingOrders(account: string) {
    return [...this.waiting.values()].filter((x) => x.account === account).map((x) => x.order);
  }
  async allPending() {
    return [...this.waiting.values()];
  }
  async savePending(account: string, order: PendingOrder) {
    this.waiting.set(order.id, { account, order });
  }
  async deletePending(_account: string, id: string) {
    this.waiting.delete(id);
  }
  async trades(account: string, limit: number) {
    return this.tr.filter((x) => x.account === account).map((x) => x.trade).reverse().slice(0, limit);
  }
  async saveTrade(account: string, trade: PaperTrade) {
    this.tr.push({ account, trade });
  }
  async setNote(account: string, id: string, note: string) {
    const t = this.tr.find((x) => x.account === account && x.trade.id === id);
    if (!t) return false;
    t.trade.note = note;
    return true;
  }
  async reset(account: string) {
    for (const [id, x] of this.pos) if (x.account === account) this.pos.delete(id);
    for (const [id, x] of this.waiting) if (x.account === account) this.waiting.delete(id);
    this.tr = this.tr.filter((x) => x.account !== account);
  }
  async ordersSince(account: string, actor: string, since: number) {
    return this.log.filter((e) => e.account === account && e.actor === actor && e.action === "place" && e.ok && e.at >= since).length;
  }
  async audit(e: AuditEntry) {
    this.log.push(e);
  }
}
