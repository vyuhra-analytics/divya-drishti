import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import {
  accountantStatement,
  BROKER_LABELS,
  contractRows,
  insights,
  memberByYear,
  selectParts,
  statementCoverage,
  yearBySegment,
  maskCode,
  monthlyView,
  overlaps,
  looksLikeKotakPnl,
  looksLikeKotakTransactions,
  parseKotakSections,
  parseKotakTransactions,
  parseZerodhaPnl,
  parseZerodhaTradebook,
  looksLikeZerodhaPnl,
  looksLikeZerodhaTradebook,
  readXlsx,
  SEGMENT_LABELS,
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

const round2 = (n: number) => Math.round(n * 100) / 100;
/** contracts sent with a summary: ample for a household, bounded so one answer cannot grow without limit */
const MAX_CONTRACTS_SENT = 5000;

export interface ImportResult {
  dry: boolean;
  id?: number;
  kind: ImportKind;
  segment: Segment;
  /** every segment the file held, when it held more than one (Kotak's all-segment report): each is stored as its own statement */
  segments?: Segment[];
  periodFrom: string;
  periodTo: string;
  fileName: string;
  /** the file's client id, masked */
  client: string;
  /** the account it goes to; null when none exists yet for this client id (one is created on import) */
  account: { id: number; label: string } | null;
  newAccount: boolean;
  /** the member a new account was filed under because the file printed that member's name (Kotak files); absent when an "Unassigned" member was created */
  filedUnder?: string;
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
      // which statements and tradebooks are loaded for which year, whatever the screen is filtered to: it is about the files
      coverage: statementCoverage(accounts, imports),
      // every year or period a statement can be exported for (a statement that could not be cut to financial years has its own period)
      statementPeriods: [...new Set(selectParts(accounts, imports).map((p) => p.fy))].sort(),
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
    let next = { ...cur, ...patch };
    // moving an account to a member who already has one of that name is routine (every first account is "<Broker> account"): keep the move and tell the two apart
    if (body?.label === undefined && patch.memberId !== undefined) {
      const taken = (label: string) => accounts.some((a) => a.id !== id && a.memberId === next.memberId && a.label.toLowerCase() === label.toLowerCase());
      if (taken(next.label)) {
        const base = `${next.label} (${BROKER_LABELS[next.broker]})`;
        let label = base;
        for (let n = 2; taken(label); n++) label = `${base} ${n}`;
        next = { ...next, label };
        patch.label = label;
      }
    }
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
    // what the file holds: one statement or tradebook, or (Kotak) one statement per segment section
    interface Part {
      kind: ImportKind;
      parsed: any;
    }
    let parts: Part[];
    let broker: Broker = "zerodha";
    let clientName: string | undefined;
    try {
      if (looksLikeKotakTransactions(sheets)) {
        // Kotak's tradebook: every fill with its date and charges, one tradebook per segment (NSE derivatives, MCX)
        broker = "kotak";
        const all = parseKotakTransactions(sheets);
        clientName = all[0].clientName;
        parts = all.map((parsed) => ({ kind: "tradebook" as const, parsed }));
      } else if (looksLikeKotakPnl(sheets)) {
        broker = "kotak";
        const all = parseKotakSections(sheets);
        clientName = all[0].clientName;
        parts = all.map((parsed) => ({ kind: "pnl" as const, parsed }));
      } else if (looksLikeZerodhaPnl(sheets)) parts = [{ kind: "pnl", parsed: parseZerodhaPnl(sheets) }];
      else if (looksLikeZerodhaTradebook(sheets)) parts = [{ kind: "tradebook", parsed: parseZerodhaTradebook(sheets) }];
      else throw new Error("this is neither a Zerodha Console P&L statement or tradebook nor a Kotak Neo Gain-Loss or Transaction Statement (other brokers' files are not read yet)");
    } catch (e) {
      throw new UnprocessableEntityException((e as Error).message);
    }
    const first = parts[0].parsed;
    const code = String(first.clientCode).toUpperCase();
    if (!code) throw new UnprocessableEntityException("the file has no client id, so it cannot be matched to an account");
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    // a file with several segments is stored as one statement per segment, so each has its own hash (the file's, then the segment)
    const hashOf = (p: Part) => (parts.length > 1 ? `${fileHash}:${p.parsed.segment}` : fileHash);

    // which account: the one named, else the one with this client id, else a new one (created below, never on a dry run)
    const accounts = await this.store.accounts();
    let account: FamilyAccount | undefined;
    if (accountId !== undefined) {
      account = accounts.find((a) => a.id === accountId);
      if (!account) throw new NotFoundException("no such account");
      if (account.broker !== broker) throw new UnprocessableEntityException(`this is a ${BROKER_LABELS[broker]} file, but account "${account.label}" is a ${BROKER_LABELS[account.broker]} account`);
      if (account.clientCode && account.clientCode !== code) throw new ConflictException(`this file is for client id ${maskCode(code)}, but account "${account.label}" is ${maskCode(account.clientCode)}: pick the right account, or leave the account empty to match by client id`);
    } else account = accounts.find((a) => a.broker === broker && a.clientCode === code);

    // everything is checked before anything is stored, so a file with several segments is taken whole or not at all
    if (account) {
      for (const part of parts) if (await this.store.hasHash(account.id, hashOf(part))) throw new ConflictException("this exact file is already imported for this account");
      const stored = await this.store.imports();
      for (const part of parts) {
        const same = stored.filter((i) => i.accountId === account!.id && i.kind === part.kind && i.segment === part.parsed.segment);
        const clash = same.find((i) => overlaps({ from: i.periodFrom, to: i.periodTo }, { from: part.parsed.periodFrom, to: part.parsed.periodTo }));
        if (clash) throw new ConflictException(`its ${SEGMENT_LABELS[part.parsed.segment as Segment]} period (${part.parsed.periodFrom} to ${part.parsed.periodTo}) overlaps ${clash.fileName} (${clash.periodFrom} to ${clash.periodTo}) already imported: remove that one first, or import a period that does not overlap`);
      }
    }
    const problems = parts.flatMap((p) => (p.kind === "pnl" ? (p.parsed.problems as string[]) : []));
    if (problems.length && !opts.accept && !opts.dry) throw new UnprocessableEntityException(`the statement does not add up, so it was not imported: ${problems.join("; ")}`);

    const sum = (f: (p: Part) => number) => parts.reduce((a, p) => a + f(p), 0);
    const result: ImportResult = {
      dry: !!opts.dry,
      kind: first === parts[0].parsed ? parts[0].kind : "pnl",
      segment: first.segment,
      ...(parts.length > 1 ? { segments: parts.map((p) => p.parsed.segment as Segment) } : {}),
      periodFrom: first.periodFrom,
      periodTo: first.periodTo,
      fileName: name,
      client: maskCode(code),
      account: account ? { id: account.id, label: account.label } : null,
      newAccount: !account,
      rows: sum((p) => (p.kind === "pnl" ? p.parsed.lines.length : p.parsed.fills.length)),
      ...(parts[0].kind === "pnl"
        ? { summary: { charges: round2(sum((p) => p.parsed.summary.charges)), otherCreditDebit: round2(sum((p) => p.parsed.summary.otherCreditDebit)), realized: round2(sum((p) => p.parsed.summary.realized)), unrealized: round2(sum((p) => p.parsed.summary.unrealized)) } }
        : {}),
      problems,
      notes: parts[0].kind === "tradebook" ? first.notes : [],
    };
    if (opts.dry) return result;

    if (!account) {
      const members = await this.store.members();
      if (members.length >= MAX_MEMBERS) throw new UnprocessableEntityException(`at most ${MAX_MEMBERS} members: remove an unused one first`);
      if (accounts.length >= MAX_ACCOUNTS) throw new UnprocessableEntityException(`at most ${MAX_ACCOUNTS} accounts`);
      // a file that prints the holder's name (Kotak's) goes under the member of that name when there is one; the name itself is never stored
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const named = clientName && norm(clientName) ? members.filter((m) => norm(m.nickname) === norm(clientName!)) : [];
      let n = 1;
      while (members.some((m) => m.nickname.toLowerCase() === `unassigned ${n}`)) n++;
      const member = named.length === 1 ? named[0] : await this.store.addMember({ nickname: `Unassigned ${n}`, relation: "", hidden: false, note: "Created from an imported file: rename it to the person, or move the account to an existing member." });
      account = await this.store.addAccount({ memberId: member.id, broker, label: `${BROKER_LABELS[broker]} account`, clientCode: code });
      result.account = { id: account.id, label: account.label };
      if (named.length === 1) result.filedUnder = member.nickname;
    } else if (!account.clientCode) {
      await this.store.updateAccount(account.id, { clientCode: code });
    }
    let firstId: number | undefined;
    for (const part of parts) {
      const saved = await this.store.addImport({
        accountId: account.id,
        kind: part.kind,
        segment: part.parsed.segment,
        periodFrom: part.parsed.periodFrom,
        periodTo: part.parsed.periodTo,
        fileName: name,
        fileHash: hashOf(part),
        summary: part.kind === "pnl" ? part.parsed.summary : { charges: 0, otherCreditDebit: 0, realized: 0, unrealized: 0 },
        lines: part.kind === "pnl" ? part.parsed.lines : [],
        charges: part.kind === "pnl" ? part.parsed.charges : [],
        fills: part.kind === "tradebook" ? part.parsed.fills : [],
        problems: part.kind === "pnl" ? part.parsed.problems : [],
      });
      firstId ??= saved.id;
    }
    return { ...result, id: firstId, newAccount: result.newAccount };
  }

  async summary(filter: Filter) {
    const [members, accounts, imports] = await Promise.all([this.store.members(), this.store.accounts(), this.store.imports()]);
    const parts = selectParts(accounts, imports, filter);
    const contracts = contractRows(parts);
    return {
      summary: summarize(members, accounts, imports, filter),
      monthly: monthlyView(members, accounts, imports, filter),
      // every contract of the selection (a household's statements are a few hundred to a few thousand), why the result is what it is, and the two cross-tables
      contracts: contracts.slice(0, MAX_CONTRACTS_SENT),
      contractsTotal: contracts.length,
      insights: insights(contracts, parts) ?? null,
      yearBySegment: yearBySegment(parts),
      memberByYear: memberByYear(parts, members),
    };
  }

  /** One member's financial year as a statement for the accountant (the screen turns it into a page or a CSV). */
  async statement(memberId: number | undefined, period: string | undefined) {
    if (memberId === undefined) throw new BadRequestException("member is required");
    if (!period || !/^\d{4}-\d{2}$|^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/.test(period)) throw new BadRequestException("period must be a financial year like 2024-25 (or a statement's own period)");
    const [members, accounts, imports] = await Promise.all([this.store.members(), this.store.accounts(), this.store.imports()]);
    if (!members.some((m) => m.id === memberId)) throw new NotFoundException("no such member");
    const st = accountantStatement(members, accounts, imports, memberId, period);
    if (!st) throw new NotFoundException(`no statement for that member in ${period}`);
    return st;
  }
}
