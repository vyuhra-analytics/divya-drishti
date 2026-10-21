import { futuresByExpiry, INSTRUMENTS, rollByVolume, tvContract, type MasterRow } from "@drishti/shared";

const MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz";
const SCAN_URL = "https://scanner.tradingview.com/global/scan";
const TV_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.tradingview.com",
  Referer: "https://www.tradingview.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36",
};

/** Traded MCX contract per underlying (CRUDEOIL → CRUDEOIL FUT 19 NOV 26). Public file, no login needed. */
export type Fronts = Map<string, MasterRow>;

/** Today's volume per dated TradingView code (MCX:NATURALGASV2026 → 69839). Best effort: empty map on failure. */
async function tvVolumes(codes: string[]): Promise<Map<string, number>> {
  try {
    const res = await fetch(SCAN_URL, {
      method: "POST",
      headers: TV_HEADERS,
      body: JSON.stringify({ symbols: { tickers: codes }, columns: ["volume"] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return new Map();
    const json: any = await res.json();
    return new Map((json?.data ?? []).filter((r: any) => typeof r.d?.[0] === "number").map((r: any) => [r.s, r.d[0]]));
  } catch {
    return new Map();
  }
}

/** Last price per dated TradingView code, for pricing both sides of a roll. Best effort: empty map on failure. */
export async function tvCloses(codes: string[]): Promise<Map<string, number>> {
  try {
    const res = await fetch(SCAN_URL, { method: "POST", headers: TV_HEADERS, body: JSON.stringify({ symbols: { tickers: codes }, columns: ["close"] }), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return new Map();
    const json: any = await res.json();
    return new Map((json?.data ?? []).filter((r: any) => typeof r.d?.[0] === "number").map((r: any) => [r.s, r.d[0]]));
  } catch {
    return new Map();
  }
}

export async function loadFronts(now = Date.now()): Promise<Fronts> {
  const res = await fetch(MASTER_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`instrument master ${res.status}`);
  const rows: MasterRow[] = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer()))));

  // two nearest contracts per underlying, then roll to whichever is actually traded today
  const candidates = new Map<string, { tv: string; rows: MasterRow[] }>();
  for (const i of INSTRUMENTS) {
    if (i.upstox) candidates.set(i.upstox, { tv: i.tv, rows: futuresByExpiry(rows, i.upstox, now).slice(0, 2) });
  }
  const code = (tv: string, r: MasterRow) => tvContract(tv, r.expiry!);
  const volumes = await tvVolumes([...candidates.values()].flatMap(({ tv, rows }) => rows.map((r) => code(tv, r))));

  const fronts: Fronts = new Map();
  for (const [underlying, { tv, rows }] of candidates) {
    const row = rollByVolume(rows, (r) => volumes.get(code(tv, r)));
    if (row) fronts.set(underlying, row);
  }
  return fronts;
}
