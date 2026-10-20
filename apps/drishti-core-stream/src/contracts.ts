import { frontMonth, INSTRUMENTS, type MasterRow } from "@drishti/shared";

const MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz";

/** Front-month MCX contract per underlying (CRUDEOIL → CRUDEOIL FUT 19 NOV 26). Public file, no login needed. */
export type Fronts = Map<string, MasterRow>;

export async function loadFronts(now = Date.now()): Promise<Fronts> {
  const res = await fetch(MASTER_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`instrument master ${res.status}`);
  const rows: MasterRow[] = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer()))));
  const fronts: Fronts = new Map();
  for (const i of INSTRUMENTS) {
    if (!i.upstox) continue;
    const row = frontMonth(rows, i.upstox, now);
    if (row) fronts.set(i.upstox, row);
  }
  return fronts;
}
