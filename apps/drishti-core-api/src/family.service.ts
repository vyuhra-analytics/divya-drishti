import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import {
  BROKER_LABELS,
  maskCode,
  monthlyView,
  overlaps,
  parseZerodhaPnl,
  parseZerodhaTradebook,
  looksLikeZerodhaPnl,
  looksLikeZerodhaTradebook,
  readXlsx,
  summarize,
  type Broker,
  type Filter,
  type FamilyAccount,
  type FamilyMember,
  type ImportKind,
  type ImportRecord,
  type Segment,
} from "@drishti/shared";

// The household's broker statements (docs/redesign/FAMILY_ACCOUNTS.md). All rules live here over a small store interface, so they are tested with an in-memory
// store and the controller stays thin. A record-keeper: nothing here places an order, and no credential or full account number is accepted or kept.

export interface FamilyStore {
  members(): Promise<FamilyMember[]>;
  accounts(): Promise<FamilyAccount[]>;
  imports(): Promise<ImportRecord[]>;
  addMember(m: Omit<FamilyMember, "id">): Promise<FamilyMember>;
  updateMember(id: number, patch: Partial<Omit<FamilyMember, "id">>): Promise<FamilyMember | undefined>;
  deleteMember(id: number): Promise<void>;
  addAccount(a: Omit<FamilyAccount, "id">): Promise<FamilyAccount>;
  updateAccount(id: number, patch: Partial<Pick<FamilyAccount, "memberId" | "label" | "clientCode">>): Promise<FamilyAccount | undefined>;
  deleteAccount(id: number): Promise<void>;
  addImport(r: Omit<ImportRecord, "id" | "importedAt"> & { fileHash: string }): Promise<ImportRecord>;
  hasHash(accountId: number, hash: string): Promise<boolean>;
  deleteImport(id: number): Promise<boolean>;
}

const TEXT = /^[^\u0000-\u001f<>]+$/;
export const MAX_MEMBERS = 12;
export const MAX_ACCOUNTS = 40;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const BROKERS: Broker[] = ["zerodha", "kotak", "other"];

function text(v: unknown, field: string, max: number, required: boolean): string {
  if (v === undefined || v === null || v === "") {
    if (required) throw new BadRequestException(`${field} is required`);
    return "";
  }
  if (typeof v !== "string" || v.trim().length > max || !TEXT.test(v.trim())) throw new BadRequestException(`${field} must be plain text of at most ${max} characters`);
  return v.trim();
}

export interface ImportResult {
  dry: boolean;
  id?: number;
  kind: ImportKind;
  segment: Segment;
  periodFrom: string;
  periodTo: string;
  fileName: string;
  /** the file's client id, masked */
  client: string;
  /** the account it goes to; null when none exists yet for this client id (one is created on import) */
  account: { id: number; label: string } | null;
  newAccount: boolean;
  /** symbols (statement) or fills (tradebook) read */
  rows: number;
  summary?: { charges: number; otherCreditDebit: number; realized: number; unrealized: number };
  problems: string[];
  notes: string[];
}

export class FamilyService {
  constructor(private readonly store: FamilyStore) {}

  async overview() {
    const [members, accounts, imports] = await Promise.all([this.store.members(), this.store.accounts(), this.store.imports()]);
    return {
      members,
      accounts,
      // the list a screen needs, without the parsed content
      imports: imports.map((i) => ({ id: i.id, accountId: i.accountId, kind: i.kind, segment: i.segment, periodFrom: i.periodFrom, periodTo: i.periodTo, fileName: i.fileName, importedAt: i.importedAt, rows: i.kind === "pnl" ? i.lines.length : i.fills.length, problems: i.problems })),
    };
  }

  async addMember(body: any) {
    const nickname = text(body?.nickname, "nickname", 40, true);
    const relation = text(body?.relation, "relation", 30, false);
    const note = text(body?.note, "note", 200, false);
    const members = await this.store.members();
    if (members.length >= MAX_MEMBERS) throw new UnprocessableEntityException(`at most ${MAX_MEMBERS} members`);
    if (members.some((m) => m.nickname.toLowerCase() === nickname.toLowerCase())) throw new ConflictException(`there is already a member called ${nickname}`);
    return this.store.addMember({ nickname, relation, hidden: false, note });
  }

  async updateMember(id: number, body: any) {
    const patch: Partial<Omit<FamilyMember, "id">> = {};
    if (body?.nickname !== undefined) patch.nickname = text(body.nickname, "nickname", 40, true);
    if (body?.relation !== undefined) patch.relation = text(body.relation, "relation", 30, false);
    if (body?.note !== undefined) patch.note = text(body.note, "note", 200, false);
    if (body?.hidden !== undefined) {
      if (typeof body.hidden !== "boolean") throw new BadRequestException("hidden must be true or false");
      patch.hidden = body.hidden;
    }
    if (patch.nickname) {
      const clash = (await this.store.members()).find((m) => m.id !== id && m.nickname.toLowerCase() === patch.nickname!.toLowerCase());
      if (clash) throw new ConflictException(`there is already a member called ${patch.nickname}`);
    }
    const m = await this.store.updateMember(id, patch);
    if (!m) throw new NotFoundException("no such member");
    return m;
  }

  async deleteMember(id: number) {
    const accounts = await this.store.accounts();
    if (accounts.some((a) => a.memberId === id)) throw new ConflictException("remove this member's accounts first");
    await this.store.deleteMember(id);
    return { ok: true };
  }

  async addAccount(body: any) {
    const memberId = Number(body?.memberId);
    if (!Number.isInteger(memberId)) throw new BadRequestException("memberId is required");
    if (!BROKERS.includes(body?.broker)) throw new BadRequestException(`broker must be one of ${BROKERS.join(", ")}`);
    const label = text(body?.label, "label", 40, true);
    const clientCode = text(body?.clientCode, "clientCode", 20, false).toUpperCase();
    if (clientCode && !/^[A-Z0-9]{3,20}$/.test(clientCode)) throw new BadRequestException("clientCode is the broker's client id: 3 to 20 letters or digits");
    const [members, accounts] = await Promise.all([this.store.members(), this.store.accounts()]);
    if (!members.some((m) => m.id === memberId)) throw new NotFoundException("no such member");
    if (accounts.length >= MAX_ACCOUNTS) throw new UnprocessableEntityException(`at most ${MAX_ACCOUNTS} accounts`);
    if (accounts.some((a) => a.memberId === memberId && a.label.toLowerCase() === label.toLowerCase())) throw new ConflictException(`this member already has an account called ${label}`);
    if (clientCode && accounts.some((a) => a.broker === body.broker && a.clientCode === clientCode)) throw new ConflictException(`a ${BROKER_LABELS[body.broker as Broker]} account with client id ${maskCode(clientCode)} already exists`);
    return this.store.addAccount({ memberId, broker: body.broker, label, clientCode });
  }

  /** Renames an account or moves it to another member (how an account created from a file is mapped to the right person later). */
  async updateAccount(id: number, body: any) {
    const patch: Partial<Pick<FamilyAccount, "memberId" | "label" | "clientCode">> = {};
    const [members, accounts] = await Promise.all([this.store.members(), this.store.accounts()]);
    const cur = accounts.find((a) => a.id === id);
    if (!cur) throw new NotFoundException("no such account");
    if (body?.label !== undefined) patch.label = text(body.label, "label", 40, true);
    if (body?.memberId !== undefined) {
      const mid = Number(body.memberId);
      if (!Number.isInteger(mid) || !members.some((m) => m.id === mid)) throw new NotFoundException("no such member");
      patch.memberId = mid;
    }
    const next = { ...cur, ...patch };
    if (accounts.some((a) => a.id !== id && a.memberId === next.memberId && a.label.toLowerCase() === next.label.toLowerCase())) throw new ConflictException(`this member already has an account called ${next.label}`);
    return (await this.store.updateAccount(id, patch))!;
  }

  async deleteAccount(id: number) {
    const imports = await this.store.imports();
    if (imports.some((i) => i.accountId === id)) throw new ConflictException("remove this account's imported files first");
    await this.store.deleteAccount(id);
    return { ok: true };
  }

  async deleteImport(id: number) {
    if (!(await this.store.deleteImport(id))) throw new NotFoundException("no such import");
    return { ok: true };
  }

  /**
   * Reads an uploaded workbook and, unless `dry`, stores what it says. The file finds its account by the broker's client id; with no account named and none
   * known for that client id, one is created under a new "Unassigned" member so the owner can name the person later (rename the member, or move the account to
   * an existing member). Refuses: a file that is not a statement or tradebook this app reads, a broker with no reader yet, a file that belongs to another
   * client id than the account named, the same file twice, a period that overlaps one already stored for the same kind and segment (that would count trades
   * twice), and a statement whose totals do not add up (unless `accept`).
   */
  async importFile(accountId: number | undefined, fileName: string, bytes: Uint8Array, opts: { dry?: boolean; accept?: boolean } = {}): Promise<ImportResult> {
    if (bytes.length === 0) throw new BadRequestException("the file is empty");
    if (bytes.length > MAX_FILE_BYTES) throw new BadRequestException("the file is too big to be a broker statement");
    const name = text(fileName || "upload.xlsx", "file name", 120, false) || "upload.xlsx";

    let sheets;
    try {
      sheets = await readXlsx(bytes);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    let kind: ImportKind;
    let parsed;
    try {
      if (looksLikeZerodhaPnl(sheets)) {
        kind = "pnl";
        parsed = parseZerodhaPnl(sheets);
      } else if (looksLikeZerodhaTradebook(sheets)) {
        kind = "tradebook";
        parsed = parseZerodhaTradebook(sheets);
      } else throw new Error("this is neither a Zerodha Console P&L statement nor a tradebook (other brokers' files are not read yet)");
    } catch (e) {
      throw new UnprocessableEntityException((e as Error).message);
    }
    const code = parsed.clientCode.toUpperCase();
    if (!code) throw new UnprocessableEntityException("the file has no client id, so it cannot be matched to an account");

    // which account: the one named, else the one with this client id, else a new one (created below, never on a dry run)
    const accounts = await this.store.accounts();
    let account: FamilyAccount | undefined;
    if (accountId !== undefined) {
      account = accounts.find((a) => a.id === accountId);
      if (!account) throw new NotFoundException("no such account");
      if (account.broker !== "zerodha") throw new UnprocessableEntityException(`there is no reader for ${BROKER_LABELS[account.broker]} files yet`);
      if (account.clientCode && account.clientCode !== code) throw new ConflictException(`this file is for client id ${maskCode(code)}, but account "${account.label}" is ${maskCode(account.clientCode)}: pick the right account, or leave the account empty to match by client id`);
    } else account = accounts.find((a) => a.broker === "zerodha" && a.clientCode === code);

    if (account) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (await this.store.hasHash(account.id, hash)) throw new ConflictException("this exact file is already imported for this account");
      const same = (await this.store.imports()).filter((i) => i.accountId === account!.id && i.kind === kind && i.segment === parsed.segment);
      const clash = same.find((i) => overlaps({ from: i.periodFrom, to: i.periodTo }, { from: parsed.periodFrom, to: parsed.periodTo }));
      if (clash) throw new ConflictException(`its period (${parsed.periodFrom} to ${parsed.periodTo}) overlaps ${clash.fileName} (${clash.periodFrom} to ${clash.periodTo}) already imported: remove that one first, or import a period that does not overlap`);
    }
    const problems = kind === "pnl" ? (parsed as ReturnType<typeof parseZerodhaPnl>).problems : [];
    if (problems.length && !opts.accept && !opts.dry) throw new UnprocessableEntityException(`the statement does not add up, so it was not imported: ${problems.join("; ")}`);

    const result: ImportResult = {
      dry: !!opts.dry,
      kind,
      segment: parsed.segment,
      periodFrom: parsed.periodFrom,
      periodTo: parsed.periodTo,
      fileName: name,
      client: maskCode(code),
      account: account ? { id: account.id, label: account.label } : null,
      newAccount: !account,
      rows: kind === "pnl" ? (parsed as any).lines.length : (parsed as any).fills.length,
      ...(kind === "pnl" ? { summary: (parsed as any).summary } : {}),
      problems,
      notes: kind === "tradebook" ? (parsed as any).notes : [],
    };
    if (opts.dry) return result;

    if (!account) {
      const members = await this.store.members();
      if (members.length >= MAX_MEMBERS) throw new UnprocessableEntityException(`at most ${MAX_MEMBERS} members: remove an unused one first`);
      if (accounts.length >= MAX_ACCOUNTS) throw new UnprocessableEntityException(`at most ${MAX_ACCOUNTS} accounts`);
      let n = 1;
      while (members.some((m) => m.nickname.toLowerCase() === `unassigned ${n}`)) n++;
      const member = await this.store.addMember({ nickname: `Unassigned ${n}`, relation: "", hidden: false, note: "Created from an imported file: rename it to the person, or move the account to an existing member." });
      account = await this.store.addAccount({ memberId: member.id, broker: "zerodha", label: "Trading account", clientCode: code });
      result.account = { id: account.id, label: account.label };
    } else if (!account.clientCode) {
      await this.store.updateAccount(account.id, { clientCode: code });
    }
    const saved = await this.store.addImport({
      accountId: account.id,
      kind,
      segment: parsed.segment,
      periodFrom: parsed.periodFrom,
      periodTo: parsed.periodTo,
      fileName: name,
      fileHash: createHash("sha256").update(bytes).digest("hex"),
      summary: kind === "pnl" ? (parsed as any).summary : { charges: 0, otherCreditDebit: 0, realized: 0, unrealized: 0 },
      lines: kind === "pnl" ? (parsed as any).lines : [],
      charges: kind === "pnl" ? (parsed as any).charges : [],
      fills: kind === "tradebook" ? (parsed as any).fills : [],
      problems,
    });
    return { ...result, id: saved.id, newAccount: result.newAccount };
  }

  async summary(filter: Filter) {
    const [members, accounts, imports] = await Promise.all([this.store.members(), this.store.accounts(), this.store.imports()]);
    return { summary: summarize(members, accounts, imports, filter), monthly: monthlyView(members, accounts, imports, filter) };
  }
}
