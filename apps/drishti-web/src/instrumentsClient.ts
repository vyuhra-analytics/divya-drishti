import { INSTRUMENTS, parseCustomInstrument, setCustomInstruments, SYMBOLS, type Instrument } from "@drishti/shared";
import { streamHttpUrl } from "./settings";
import { resubscribeSymbols, useStore } from "./store";

export type CallResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/** Call the stream's /instruments API. Failures come back as a result with a readable message, never as an exception. */
export async function instrumentsCall<T = any>(path = "", method = "GET", body?: unknown): Promise<CallResult<T>> {
  try {
    const res = await fetch(streamHttpUrl(`/instruments${path}`), { method, headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, data: json as T } : { ok: false, status: res.status, error: json?.error ?? `HTTP ${res.status}` };
  } catch {
    return { ok: false, status: 0, error: "The stream service is unreachable" };
  }
}

/**
 * Make the catalogue in this browser match the server's. Returns true when it changed (the app then remounts). Every entry is validated
 * again here; if the stream is down the catalogue stays as it is.
 */
export async function syncInstruments(): Promise<boolean> {
  const r = await instrumentsCall<{ instruments: Instrument[] }>();
  if (!r.ok) return false;
  const accepted: Instrument[] = [];
  const builtins = INSTRUMENTS.filter((i) => !i.custom);
  for (const i of r.data.instruments.filter((x) => x.custom)) {
    const p = parseCustomInstrument({ ...i, root: i.symbol.split(":")[1] }, [...builtins, ...accepted]);
    if ("instrument" in p) accepted.push(p.instrument);
  }
  const before = SYMBOLS.join(",");
  setCustomInstruments(accepted);
  if (SYMBOLS.join(",") === before) return false;
  resubscribeSymbols();
  useStore.setState((s) => ({ instrumentsRev: s.instrumentsRev + 1 }));
  return true;
}
