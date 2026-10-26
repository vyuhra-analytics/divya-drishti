// The feed recorder: copies what Upstox sends while the market is open into `feed_quotes` (infra/sql/019_feed_quotes.sql), because none of it can be
// asked for afterwards. Futures come through accept() (every change of the Upstox quote), options from the same feed connection: the recorder asks
// for the contracts near the money of the two option underlyings (shared `selectRecordingContracts`, the choice the candle recorder uses) and
// the stream subscribes them next to whatever a browser is watching. Rows are buffered and inserted every 2 s; a failed insert is kept and retried.
import type { SQL } from "bun";
import { FeedThrottle, INSTRUMENTS, optionRow, quoteRow, RECORD_EXPIRIES, selectRecordingContracts, type FeedRow, type OptionContract, type OptionQuote, type Quote } from "@drishti/shared";
import { loadOurContractRows } from "./contracts";

const FLUSH_MS = 2_000;
const CONTRACTS_MS = 5 * 60_000; // re-centre on the money as the future moves
const MAX_BUFFER = 50_000; // rows kept across failed inserts; past this the oldest are dropped (counted)
/** strikes each side of the money, calls and puts; 8 gives 34 contracts per expiry */
const STRIKES_EACH_SIDE = Number(process.env.FEED_RECORDER_STRIKES) > 0 ? Number(process.env.FEED_RECORDER_STRIKES) : 8;

export interface FeedRecorderStats {
  on: boolean;
  rows: number;
  failedInserts: number;
  dropped: number;
  contracts: number;
  lastRowAt: number | null;
  lastError?: string;
}

/** `spotOf(underlying)` is the live price of the front future of an Upstox underlying (CRUDEOIL), or undefined. */
export function startFeedRecorder(sql: SQL, spotOf: (underlying: string) => number | undefined) {
  const stats: FeedRecorderStats = { on: true, rows: 0, failedInserts: 0, dropped: 0, contracts: 0, lastRowAt: null };
  const futures = new FeedThrottle(0); // a futures quote already arrives only when something changed
  const options = new FeedThrottle(1_000);
  let buf: FeedRow[] = [];
  let wanted: string[] = [];
  let wantedSet = new Set<string>();
  const listeners: (() => void)[] = [];

  const push = (row: FeedRow) => {
    buf.push(row);
    if (buf.length > MAX_BUFFER) {
      stats.dropped += buf.length - MAX_BUFFER;
      buf = buf.slice(-MAX_BUFFER);
    }
  };

  async function flush() {
    if (!buf.length) return;
    const rows = buf;
    buf = [];
    const payload = rows.map((r) => ({ ...r, depth: r.depth ?? null }));
    try {
      await sql`
        INSERT INTO feed_quotes (time, key, trade_at, price, volume, bid, ask, bid_qty, ask_qty, oi, atp, ltq, total_buy_qty, total_sell_qty, prev_close, depth, iv, delta, theta, gamma, vega, rho)
        SELECT to_timestamp("recvAt" / 1000.0), key, to_timestamp("tradeAt" / 1000.0), NULLIF(price, 0), volume, bid, ask, "bidQty", "askQty", oi, atp, ltq, "totalBuyQty", "totalSellQty", "prevClose", depth, iv, delta, theta, gamma, vega, rho
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::text::jsonb) AS x(
          "recvAt" double precision, key text, "tradeAt" double precision, price double precision, volume double precision, bid double precision, ask double precision,
          "bidQty" double precision, "askQty" double precision, oi double precision, atp double precision, ltq double precision, "totalBuyQty" double precision,
          "totalSellQty" double precision, "prevClose" double precision, depth jsonb, iv double precision, delta double precision,
          theta double precision, gamma double precision, vega double precision, rho double precision)`;
      stats.rows += rows.length;
      stats.lastRowAt = rows[rows.length - 1].recvAt;
    } catch (err) {
      stats.failedInserts++;
      stats.lastError = (err as Error).message;
      buf = [...rows, ...buf]; // keep them for the next flush
      if (buf.length > MAX_BUFFER) {
        stats.dropped += buf.length - MAX_BUFFER;
        buf = buf.slice(-MAX_BUFFER);
      }
    }
  }

  async function refreshContracts() {
    try {
      const rows = await loadOurContractRows();
      const underlyings = [...new Set(INSTRUMENTS.flatMap((i) => (i.upstox ? [i.upstox] : [])))];
      const contracts: OptionContract[] = rows.filter((r) => r.instrument_type === "CE" || r.instrument_type === "PE");
      // every listed future of our underlyings (the curve) rides along: a handful of contracts, and the front ones are the screens' quotes
      const futureKeys = rows.filter((r) => r.instrument_type === "FUT").map((r) => r.instrument_key as string);
      // ponytail: every expiry's spot is taken as the front future's price; the strikes picked are a few off the true money for a far expiry, never wrong contracts
      const spots: Record<string, number | undefined> = {};
      for (const c of contracts) spots[c.underlying_key] = spotOf(c.underlying_symbol);
      const near = selectRecordingContracts(contracts, spots, Date.now(), underlyings, RECORD_EXPIRIES, STRIKES_EACH_SIDE).map((c) => c.instrument_key);
      const next = [...near, ...futureKeys].sort();
      stats.contracts = next.length;
      if (next.join(",") !== wanted.join(",")) {
        wanted = next;
        wantedSet = new Set(next);
        listeners.forEach((fn) => fn());
      }
    } catch (err) {
      stats.lastError = `contracts: ${(err as Error).message}`;
    }
  }

  setInterval(flush, FLUSH_MS);
  setInterval(refreshContracts, CONTRACTS_MS);
  setTimeout(refreshContracts, 20_000); // after the first futures quotes, so the money is known

  return {
    stats,
    /** the option contracts to keep subscribed on the Upstox feed */
    keys: () => wanted,
    onChange: (fn: () => void) => void listeners.push(fn),
    /** every quote the stream accepts; only the Upstox ones are recorded, whether or not Upstox is the one shown */
    onQuote(q: Quote) {
      if (q.source !== "upstox") return;
      const row = quoteRow(q, Date.now());
      if (futures.keep(row)) push(row);
    },
    onOption(q: OptionQuote) {
      if (!wantedSet.has(q.key)) return;
      const row = optionRow(q);
      if (options.keep(row)) push(row);
    },
    flush,
  };
}
