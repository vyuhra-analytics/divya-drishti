// Energy universe for the heatmap and screener: our futures plus benchmarks, energy equities, ETFs and FX.
// Prices come from TradingView's scanner (free; futures 10 min and stocks 15 min delayed). Our six instruments
// are overridden in the web app by their live quotes.

export type UniverseGroup = "MCX futures" | "Benchmarks" | "India energy" | "US energy" | "ETFs" | "FX";

export interface UniverseItem {
  /** TradingView ticker (MCX: root, resolved to the dated front month by the stream) */
  tv: string;
  name: string;
  group: UniverseGroup;
  currency: "INR" | "USD";
  /** our instrument, when this row is one of the six we stream live */
  symbol?: string;
}

export const ENERGY_UNIVERSE: UniverseItem[] = [
  { tv: "MCX:CRUDEOIL", name: "Crude Oil", group: "MCX futures", currency: "INR", symbol: "MCX:CRUDEOIL" },
  { tv: "MCX:CRUDEOILM", name: "Crude Oil Mini", group: "MCX futures", currency: "INR", symbol: "MCX:CRUDEOILM" },
  { tv: "MCX:NATURALGAS", name: "Natural Gas", group: "MCX futures", currency: "INR", symbol: "MCX:NATURALGAS" },
  { tv: "MCX:NATGASMINI", name: "Natural Gas Mini", group: "MCX futures", currency: "INR", symbol: "MCX:NATGASMINI" },
  { tv: "NYMEX:CL1!", name: "WTI Crude", group: "Benchmarks", currency: "USD", symbol: "NYMEX:CL" },
  { tv: "ICEEUR:BRN1!", name: "Brent Crude", group: "Benchmarks", currency: "USD" },
  { tv: "NYMEX:NG1!", name: "Henry Hub Gas", group: "Benchmarks", currency: "USD", symbol: "NYMEX:NG" },
  { tv: "NYMEX:RB1!", name: "RBOB Gasoline", group: "Benchmarks", currency: "USD" },
  { tv: "NYMEX:HO1!", name: "ULSD (Heating Oil)", group: "Benchmarks", currency: "USD" },
  { tv: "NSE:RELIANCE", name: "Reliance Industries", group: "India energy", currency: "INR" },
  { tv: "NSE:ONGC", name: "ONGC", group: "India energy", currency: "INR" },
  { tv: "NSE:IOC", name: "Indian Oil", group: "India energy", currency: "INR" },
  { tv: "NSE:BPCL", name: "BPCL", group: "India energy", currency: "INR" },
  { tv: "NSE:GAIL", name: "GAIL", group: "India energy", currency: "INR" },
  { tv: "NSE:OIL", name: "Oil India", group: "India energy", currency: "INR" },
  { tv: "NSE:PETRONET", name: "Petronet LNG", group: "India energy", currency: "INR" },
  { tv: "NYSE:XOM", name: "ExxonMobil", group: "US energy", currency: "USD" },
  { tv: "NYSE:CVX", name: "Chevron", group: "US energy", currency: "USD" },
  { tv: "NYSE:COP", name: "ConocoPhillips", group: "US energy", currency: "USD" },
  { tv: "NYSE:EOG", name: "EOG Resources", group: "US energy", currency: "USD" },
  { tv: "NYSE:SLB", name: "SLB", group: "US energy", currency: "USD" },
  { tv: "NYSE:OXY", name: "Occidental", group: "US energy", currency: "USD" },
  { tv: "AMEX:XLE", name: "Energy Select ETF", group: "ETFs", currency: "USD" },
  { tv: "AMEX:USO", name: "US Oil Fund", group: "ETFs", currency: "USD" },
  { tv: "AMEX:UNG", name: "US Natural Gas Fund", group: "ETFs", currency: "USD" },
  { tv: "FX_IDC:USDINR", name: "USD/INR", group: "FX", currency: "INR" },
  { tv: "TVC:DXY", name: "US Dollar Index", group: "FX", currency: "USD" },
];

export const UNIVERSE_GROUPS: UniverseGroup[] = ["MCX futures", "Benchmarks", "India energy", "US energy", "ETFs", "FX"];

/** One universe row as published by the stream (topic "universe"). */
export interface UniverseRow {
  tv: string;
  price: number;
  changePct?: number;
  volume?: number;
  marketCap?: number;
  high52?: number;
  low52?: number;
  /** seconds behind the exchange (TradingView update_mode) */
  delayedBy: number;
}

export const UNIVERSE_COLUMNS = ["close", "change", "volume", "market_cap_basic", "price_52_week_high", "price_52_week_low", "update_mode"] as const;

/** TradingView scanner response → rows, keyed back to our universe tickers via `tickerOf` (MCX dated codes). */
export function parseUniverseScan(json: any, toUniverseTicker: (scanTicker: string) => string | undefined): UniverseRow[] {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const out: UniverseRow[] = [];
  for (const row of json?.data ?? []) {
    const tv = toUniverseTicker(row.s);
    const [close, change, volume, mcap, hi, lo, mode] = row.d ?? [];
    if (!tv || n(close) === undefined) continue;
    out.push({
      tv,
      price: close,
      changePct: n(change),
      volume: n(volume),
      marketCap: n(mcap),
      high52: n(hi),
      low52: n(lo),
      delayedBy: Number(/delayed_streaming_(\d+)/.exec(typeof mode === "string" ? mode : "")?.[1] ?? 0),
    });
  }
  return out;
}
