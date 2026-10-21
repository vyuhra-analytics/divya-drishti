/** Currency pairs tracked next to the futures (display and context only: nothing here is traded, charted or stored). */
export interface FxPair {
  id: string;
  /** TradingView scanner ticker */
  tv: string;
  name: string;
  decimals: number;
  /** a price outside this range is a bad quote, not a move (USD/INR has traded between about 40 and 100) */
  plausible: [number, number];
}

export const FX_PAIRS: FxPair[] = [{ id: "USDINR", tv: "FX_IDC:USDINR", name: "USD/INR", decimals: 4, plausible: [40, 200] }];

export interface FxRow {
  id: string;
  price: number;
  /** vs the previous close */
  change?: number;
  changePct?: number;
  high?: number;
  low?: number;
  /** when the stream read it, epoch ms */
  time: number;
  /** seconds behind the market (TradingView's update_mode) */
  delayedBy: number;
}

export const FX_COLUMNS = ["close", "change", "change_abs", "high", "low", "update_mode"] as const;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** "streaming" = live; "delayed_streaming_900" = 15 min behind; anything else (end of day...) is shown as a day old rather than as live. */
export function fxDelay(mode: unknown): number {
  if (mode === "streaming") return 0;
  const m = typeof mode === "string" ? mode.match(/^delayed_streaming_(\d+)$/) : null;
  return m ? Number(m[1]) : 86_400;
}

/** TradingView scanner response (columns `FX_COLUMNS`) → rows for our pairs. A missing, non-numeric or implausible price drops the row. */
export function parseFxScan(json: any, now: number): FxRow[] {
  const out: FxRow[] = [];
  for (const r of Array.isArray(json?.data) ? json.data : []) {
    const pair = FX_PAIRS.find((p) => p.tv === r?.s);
    const d = Array.isArray(r?.d) ? r.d : [];
    const price = num(d[0]);
    if (!pair || price === undefined || price < pair.plausible[0] || price > pair.plausible[1]) continue;
    out.push({ id: pair.id, price, changePct: num(d[1]), change: num(d[2]), high: num(d[3]), low: num(d[4]), time: now, delayedBy: fxDelay(d[5]) });
  }
  return out;
}
