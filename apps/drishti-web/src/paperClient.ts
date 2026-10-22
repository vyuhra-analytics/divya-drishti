import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountRow, AccountState } from "@drishti/shared";
import { streamHttpUrl } from "./settings";
import { useStore } from "./store";

export type CallResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/** Call the stream's /paper API. Failures come back as a result with a readable message, never as an exception. */
export async function paperCall<T = any>(path: string, method = "GET", body?: unknown): Promise<CallResult<T>> {
  try {
    const res = await fetch(streamHttpUrl(`/paper${path}`), { method, headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, data: json as T } : { ok: false, status: res.status, error: json?.error ?? `HTTP ${res.status}` };
  } catch {
    return { ok: false, status: 0, error: "The stream service is unreachable" };
  }
}

const POLL_MS = 10_000;

/**
 * One paper account from the server, kept current: re-read when the stream announces a change (a trade from this browser, from another
 * tab, from an agent over MCP, or a stop firing) and every 10 s as a fallback. `reload` forces a read after an action.
 */
export function usePaperAccount(accountId: string) {
  const rev = useStore((s) => s.paperRev);
  const [state, setState] = useState<AccountState | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const my = ++seq.current;
    const [s, a] = await Promise.all([paperCall<{ state: AccountState }>(`/accounts/${encodeURIComponent(accountId)}`), paperCall<{ accounts: AccountRow[] }>("/accounts")]);
    if (my !== seq.current) return; // a newer read is already on its way
    if (s.ok) {
      setState(s.data.state);
      setError(null);
    } else {
      setState(null);
      setError(s.status === 0 ? s.error : s.status === 404 ? `No paper account "${accountId}"` : /relation|connect|ECONN|database/i.test(s.error) || s.status >= 500 ? "Paper trading needs the database (bun run infra:up, then bun run db:migrate)" : s.error);
    }
    if (a.ok) setAccounts(a.data.accounts);
  }, [accountId]);

  useEffect(() => {
    setState(null);
    void reload();
  }, [reload, rev]);
  useEffect(() => {
    const id = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(id);
  }, [reload]);

  return { state, accounts, error, reload };
}

/** The cost rates saved in this browser (Costs panel), if any. */
function savedCostRates(): Record<string, number> | undefined {
  try {
    return JSON.parse(localStorage.getItem("drishti-costs") ?? "null")?.rates;
  } catch {
    return undefined;
  }
}

/** The server charges paper trades, so it needs the rates the user edited in the Costs panel: push them once at start-up (nothing to push if never edited). */
export async function syncRatesToServer() {
  const rates = savedCostRates();
  if (rates) await paperCall("/rates", "PUT", rates);
}
