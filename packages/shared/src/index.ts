export type Source = "upstox" | "tradingview" | "yahoo" | "demo";

export interface Instrument {
  /** EXCHANGE:ROOT, always the continuous front-month contract */
  symbol: string;
  name: string;
  exchange: "MCX" | "NYMEX" | "FX";
  currency: "INR" | "USD";
  /** exchange time zone: candles (1h, 1d) start on its hours/midnight, like the providers' history */
  timeZone: "Asia/Kolkata" | "America/New_York";
  decimals: number;
  /** commodity, for news filtering in linked panels */
  topic: "crude" | "natgas" | "fx";
  /** contract size, display only */
  lot: string;
  /** seconds the free feed lags the exchange (CME rule: 10 min) */
  delayedBy: number;
  /** live sources in priority order; later ones are fallbacks */
  sources: Source[];
  /** Upstox instrument master `underlying_symbol` (MCX) */
  upstox?: string;
  /** TradingView root; MCX uses dated codes (CRUDEOILX2026) because MCX `1!` rolls late */
  tv: string;
  /** Yahoo chart symbol (NYMEX) */
  yahoo?: string;
  /** added by the user (Settings → Instruments), stored in Postgres; the six built-ins are never custom */
  custom?: boolean;
}

export const INSTRUMENTS: Instrument[] = [
  { symbol: "MCX:CRUDEOIL", topic: "crude", name: "Crude Oil", exchange: "MCX", currency: "INR", timeZone: "Asia/Kolkata", decimals: 0, lot: "100 bbl", delayedBy: 0, sources: ["upstox", "tradingview"], upstox: "CRUDEOIL", tv: "MCX:CRUDEOIL" },
  { symbol: "MCX:CRUDEOILM", topic: "crude", name: "Crude Oil Mini", exchange: "MCX", currency: "INR", timeZone: "Asia/Kolkata", decimals: 0, lot: "10 bbl", delayedBy: 0, sources: ["upstox", "tradingview"], upstox: "CRUDEOILM", tv: "MCX:CRUDEOILM" },
  { symbol: "MCX:NATURALGAS", topic: "natgas", name: "Natural Gas", exchange: "MCX", currency: "INR", timeZone: "Asia/Kolkata", decimals: 1, lot: "1250 mmBtu", delayedBy: 0, sources: ["upstox", "tradingview"], upstox: "NATURALGAS", tv: "MCX:NATURALGAS" },
  { symbol: "MCX:NATGASMINI", topic: "natgas", name: "Natural Gas Mini", exchange: "MCX", currency: "INR", timeZone: "Asia/Kolkata", decimals: 1, lot: "250 mmBtu", delayedBy: 0, sources: ["upstox", "tradingview"], upstox: "NATGASMINI", tv: "MCX:NATGASMINI" },
  { symbol: "NYMEX:CL", topic: "crude", name: "WTI Crude Oil", exchange: "NYMEX", currency: "USD", timeZone: "America/New_York", decimals: 2, lot: "1000 bbl", delayedBy: 600, sources: ["yahoo", "tradingview"], yahoo: "CL=F", tv: "NYMEX:CL1!" },
  { symbol: "NYMEX:NG", topic: "natgas", name: "Henry Hub Natural Gas", exchange: "NYMEX", currency: "USD", timeZone: "America/New_York", decimals: 3, lot: "10000 mmBtu", delayedBy: 600, sources: ["yahoo", "tradingview"], yahoo: "NG=F", tv: "NYMEX:NG1!" },
  { symbol: "FX:USDINR", topic: "fx", name: "USD/INR", exchange: "FX", currency: "INR", timeZone: "Asia/Kolkata", decimals: 4, lot: "1 USD", delayedBy: 0, sources: ["tradingview", "yahoo"], yahoo: "INR=X", tv: "FX_IDC:USDINR" },
];

export const SYMBOLS = INSTRUMENTS.map((i) => i.symbol);
const BY_SYMBOL = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));
export const instrument = (symbol: string) => BY_SYMBOL.get(symbol);

const BUILTIN_COUNT = INSTRUMENTS.length;
/**
 * Replace the user's instruments (see customInstruments.ts) in place: INSTRUMENTS and SYMBOLS keep their identity, so every module that
 * imported them sees the change. Input is trusted to be validated already; anything with a built-in's symbol is ignored.
 */
export function setCustomInstruments(list: Instrument[]) {
  const builtin = new Set(INSTRUMENTS.slice(0, BUILTIN_COUNT).map((i) => i.symbol));
  INSTRUMENTS.length = BUILTIN_COUNT;
  for (const i of list) if (!builtin.has(i.symbol) && !INSTRUMENTS.some((x) => x.symbol === i.symbol)) INSTRUMENTS.push({ ...i, custom: true });
  SYMBOLS.length = 0;
  SYMBOLS.push(...INSTRUMENTS.map((i) => i.symbol));
  BY_SYMBOL.clear();
  for (const i of INSTRUMENTS) BY_SYMBOL.set(i.symbol, i);
}

/** Latest snapshot for a symbol as published by the stream. time = exchange trade time, epoch ms. */
export interface Quote {
  symbol: string;
  price: number;
  time: number;
  prevClose?: number;
  open?: number;
  high?: number;
  low?: number;
  /** cumulative day volume */
  volume?: number;
  /** best bid/ask and their quantities (Upstox depth) */
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  /** open interest (contracts) */
  oi?: number;
  /** average traded price today (session VWAP) */
  atp?: number;
  /** total pending buy / sell quantity in the order book */
  totalBuyQty?: number;
  totalSellQty?: number;
  /** actual contract, e.g. "CRUDEOIL FUT 19 NOV 26" */
  contract?: string;
  source: Source;
  delayedBy: number;
  /** set by the stream when another live source disagrees with this price by more than the drift threshold (see drift.ts) */
  drift?: { between: [string, string]; pct: number; ticks: number };
}

/** time = epoch ms */
export interface Tick {
  symbol: string;
  time: number;
  price: number;
  size: number;
}

/** time = bucket start, epoch seconds */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** open interest at the bar's close (a level, not a flow), when the provider sends it: Upstox does for futures and options, Yahoo does not */
  oi?: number;
}

export const TIMEFRAMES = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 } as const;
export type Timeframe = keyof typeof TIMEFRAMES;

/** Start (epoch s) of the tf bucket containing `sec`, with boundaries in exchange time. */
export const bucketStart = (sec: number, tfSeconds: number, offsetSec = 0) =>
  Math.floor((sec + offsetSec) / tfSeconds) * tfSeconds - offsetSec;

/**
 * Snap provider bars onto our bucket grid and round away float noise. Providers sometimes append a partial
 * bar stamped at the quote time (Yahoo: 17:03:25); snapping folds it into its bucket (later bar wins).
 */
export function normalizeBars(bars: Bar[], tfSeconds: number, timeZone: string, decimals: number): Bar[] {
  const r = (x: number) => Number(x.toFixed(decimals));
  return mergeBars(
    bars.map((b) => ({
      time: bucketStart(b.time, tfSeconds, tzOffsetSec(timeZone, b.time * 1000)),
      open: r(b.open),
      high: r(b.high),
      low: r(b.low),
      close: r(b.close),
      volume: b.volume,
      ...(b.oi !== undefined ? { oi: b.oi } : {}),
    })),
  );
}

const tzFormats = new Map<string, Intl.DateTimeFormat>();

/** UTC offset of a time zone at an instant, in seconds (IST → 19800, New York → -14400 / -18000 with DST). */
export function tzOffsetSec(timeZone: string, ms: number): number {
  let f = tzFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    tzFormats.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((local - Math.floor(ms / 1000) * 1000) / 1000);
}

/**
 * Merge a tick into the current bar, or start a new bar when the tick crosses into the next bucket.
 * offsetSec shifts bucket boundaries to exchange time (so 1d = exchange midnight, 1h = exchange hours).
 */
export function applyTick(bar: Bar | undefined, tick: Tick, tfSeconds: number, offsetSec = 0): Bar {
  const bucket = bucketStart(tick.time / 1000, tfSeconds, offsetSec);
  if (!bar || bucket > bar.time) {
    return { time: bucket, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: tick.size };
  }
  if (bucket < bar.time) return bar; // late tick for an already-closed bar
  return {
    ...bar,
    high: Math.max(bar.high, tick.price),
    low: Math.min(bar.low, tick.price),
    close: tick.price,
    volume: bar.volume + tick.size,
  };
}

/**
 * Tick implied by moving from one quote to the next: size is the day-volume delta.
 * null when nothing traded (same price, same volume), so heartbeats and re-sends don't fake trades.
 * A volume drop (new session, or a different source's count) counts as size 0.
 */
export function quoteToTick(prev: Quote | undefined, q: Quote): Tick | null {
  const size = prev?.volume !== undefined && q.volume !== undefined ? Math.max(0, q.volume - prev.volume) : 0;
  if (prev && prev.price === q.price && size === 0) return null;
  return { symbol: q.symbol, time: q.time, price: q.price, size };
}

/**
 * Fallback rule: the first source (in priority order) heard from within `staleMs` wins.
 * If every source is stale (market closed, network down) keep the most recently heard one.
 */
export function pickSource(
  lastSeen: Partial<Record<Source, number>>,
  priority: Source[],
  now: number,
  staleMs: number,
): Source | undefined {
  const fresh = priority.find((s) => (lastSeen[s] ?? -Infinity) > now - staleMs);
  if (fresh) return fresh;
  return priority.filter((s) => lastSeen[s] !== undefined).sort((a, b) => lastSeen[b]! - lastSeen[a]!)[0];
}

/** `preferred` moved to the front of `sources` (unchanged when it isn't one of them), keeping the rest in order. */
export function prioritize(sources: Source[], preferred?: Source): Source[] {
  return preferred && sources.includes(preferred) ? [preferred, ...sources.filter((s) => s !== preferred)] : sources;
}

/** Upstox instrument master row (subset). expiry = epoch ms. */
export interface MasterRow {
  instrument_key: string;
  trading_symbol: string;
  instrument_type: string;
  underlying_symbol?: string;
  expiry?: number;
  lot_size?: number;
}

/** Unexpired futures for an underlying, nearest expiry first. */
export function futuresByExpiry(rows: MasterRow[], underlying: string, now: number): MasterRow[] {
  return rows
    .filter((r) => r.underlying_symbol === underlying && r.instrument_type === "FUT" && (r.expiry ?? 0) > now)
    .sort((a, b) => a.expiry! - b.expiry!);
}

/** Nearest unexpired future for an underlying (expiry-only rule; see rollByVolume for the traded-contract rule). */
export function frontMonth(rows: MasterRow[], underlying: string, now: number): MasterRow | undefined {
  return futuresByExpiry(rows, underlying, now)[0];
}

/**
 * The contract traders are actually in: MCX volume moves to the next month a few days before expiry
 * (NATURALGAS especially), so roll as soon as the next contract out-trades the nearest one today.
 * Unknown volumes (feed down, before the open) keep the nearest expiry.
 */
export function rollByVolume(candidates: MasterRow[], volumeOf: (row: MasterRow) => number | undefined): MasterRow | undefined {
  const [near, next] = candidates;
  if (!near || !next) return near;
  const v1 = volumeOf(near);
  const v2 = volumeOf(next);
  return v1 !== undefined && v2 !== undefined && v2 > v1 ? next : near;
}

const MONTH_CODES = "FGHJKMNQUVXZ";
/** TradingView dated futures code: CRUDEOIL + expiry Nov 2026 → CRUDEOILX2026 */
export function tvContract(root: string, expiryMs: number): string {
  const d = new Date(expiryMs);
  return `${root}${MONTH_CODES[d.getUTCMonth()]}${d.getUTCFullYear()}`;
}

/**
 * TradingView ticker for an instrument. MCX uses the dated contract when the front month is known; its continuous `1!` rolls late
 * (the wrong contract in the last days before expiry), so it is explicit-only: without a front month an MCX instrument gets no
 * TradingView ticker unless `allowMcxContinuous` is set (env TV_MCX_CONTINUOUS=1). NYMEX's own `1!` is the right contract.
 */
export function tvTickerFor(inst: Pick<Instrument, "tv" | "exchange">, frontExpiry: number | undefined, allowMcxContinuous = false): string | undefined {
  if (inst.exchange !== "MCX") return inst.tv;
  if (frontExpiry) return tvContract(inst.tv, frontExpiry);
  return allowMcxContinuous ? (inst.tv.endsWith("1!") ? inst.tv : `${inst.tv}1!`) : undefined;
}

/** Upstox access tokens die at 03:30 IST (UTC+5:30) the next morning, whenever they were issued. */
export function upstoxTokenExpiry(now: number): number {
  const IST = 5.5 * 3600_000;
  const ist = new Date(now + IST);
  const expiry = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 3, 30) - IST;
  return expiry > now ? expiry : expiry + 86_400_000;
}

/** Yahoo chart response → bars (bucket start = Yahoo timestamp, already exchange-aligned). Null rows skipped. */
export function parseYahooCandles(json: any): Bar[] {
  const r = json?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r?.timestamp || !q) return [];
  const out: Bar[] = [];
  r.timestamp.forEach((t: number, i: number) => {
    const [open, high, low, close] = [q.open[i], q.high[i], q.low[i], q.close[i]];
    if ([open, high, low, close].some((v) => typeof v !== "number")) return;
    out.push({ time: t, open, high, low, close, volume: q.volume?.[i] ?? 0 });
  });
  return out;
}

/** Upstox candle response ([ts, o, h, l, c, vol, oi] newest first, ts in IST) → ascending bars. */
export function parseUpstoxCandles(json: any): Bar[] {
  const rows: any[][] = json?.data?.candles ?? [];
  return rows
    .map(([ts, open, high, low, close, volume, oi]) => ({ time: Date.parse(ts) / 1000, open, high, low, close, volume: volume ?? 0, ...(typeof oi === "number" ? { oi } : {}) }))
    .filter((b) => Number.isFinite(b.time))
    .sort((a, b) => a.time - b.time);
}

/** Merge bar lists (later lists win on equal time), ascending. */
export function mergeBars(...lists: Bar[][]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const list of lists) for (const b of list) byTime.set(b.time, b);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export type ClientMessage = { subscribe: string[] } | { unsubscribe: string[] } | { watch: string[] };

export * from "./news";
export * from "./security";
export * from "./indicators";
export * from "./sessions";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** "CRUDEOIL FUT 19 NOV 26" → expiry day as UTC midnight ms; undefined if the label has no date. */
export function contractExpiry(contract?: string): number | undefined {
  const m = contract?.match(/(\d{1,2}) ([A-Z]{3}) (\d{2})$/);
  const month = m ? MONTHS.indexOf(m[2]) : -1;
  return m && month >= 0 ? Date.UTC(2000 + Number(m[3]), month, Number(m[1])) : undefined;
}

/** Whole calendar days from `now` (in IST, where MCX contracts expire) to the expiry date; 0 = expires today. */
export function daysToExpiry(contract: string | undefined, now: number): number | undefined {
  const exp = contractExpiry(contract);
  if (exp === undefined) return undefined;
  const istToday = Math.floor((now + 5.5 * 3600_000) / 86_400_000) * 86_400_000;
  return Math.round((exp - istToday) / 86_400_000);
}
export * from "./customInstruments";
export * from "./grounding";
export * from "./briefingSubmit";
export * from "./options";
export * from "./calendar";
export * from "./alerts";
export * from "./briefing";
export * from "./positions";

export * from "./tvOptions";
export * from "./lru";
export * from "./actuals";
export * from "./cot";
export * from "./chokepoints";
export * from "./stats";
export * from "./curve";
export * from "./continuous";
export * from "./eia";
export * from "./recap";
export * from "./costs";
export * from "./brokers";
export * from "./upstoxCharges";
export * from "./optionQuote";
export * from "./optionCandles";
export * from "./upstoxAccount";
export * from "./eventSeries";
export * from "./eventPlan";
export * from "./eiaReport";
export * from "./eiaWatch";
export * from "./eiaAnalysis";
export * from "./calendarSources";
export * from "./eiaSchedule";
export * from "./drivers";
export * from "./strategies";
export * from "./backtest";
export * from "./paper";
export * from "./bars";
export * from "./concurrency";
export * from "./fetcher";
export * from "./fetchers";
export * from "./fixtures";
export * from "./fixtureSamples";
export * from "./canary";
export * from "./drift";
export * from "./provenance";
export * from "./notify";
export * from "./serverAlerts";
export * from "./userAgents";
export * from "./paperServer";
