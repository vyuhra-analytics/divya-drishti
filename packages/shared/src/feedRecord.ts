// What the feed recorder stores (infra/sql/019_feed_quotes.sql): every change of a futures quote and of the option contracts we record, with
// price, cumulative volume, best bid/ask and quantities, open interest, ATP and, for options, five-level depth, IV and greeks. Upstox's data is
// not available after the market closes, so what is not stored while it flows is gone. Pure, so the "what is worth a row" rule is tested.
import type { Quote } from "./index";
import type { DepthLevel, OptionQuote } from "./optionQuote";

export interface FeedRow {
  /** futures: our symbol (MCX:CRUDEOIL); options: the Upstox instrument key (MCX_FO|582939) */
  key: string;
  /** when we received it, epoch ms: the hypertable's time */
  recvAt: number;
  /** exchange trade time, epoch ms */
  tradeAt: number;
  price: number;
  volume?: number;
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  oi?: number;
  atp?: number;
  /** quantity of the last trade, as Upstox sends it */
  ltq?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
  prevClose?: number;
  /** up to five levels, best first */
  depth?: DepthLevel[];
  iv?: number;
  delta?: number;
  theta?: number;
  gamma?: number;
  vega?: number;
  rho?: number;
}

export function quoteRow(q: Quote, recvAt: number): FeedRow {
  return {
    key: q.symbol, recvAt, tradeAt: q.time, price: q.price, volume: q.volume, bid: q.bid, ask: q.ask, bidQty: q.bidQty, askQty: q.askQty, oi: q.oi, atp: q.atp,
    ltq: q.ltq, totalBuyQty: q.totalBuyQty, totalSellQty: q.totalSellQty, prevClose: q.prevClose, depth: q.depth,
  };
}

export function optionRow(q: OptionQuote): FeedRow {
  const { key, recvAt, time, price, volume, bid, ask, bidQty, askQty, oi, atp, ltq, totalBuyQty, totalSellQty, prevClose, depth, iv, delta, theta, gamma, vega, rho } = q;
  return { key, recvAt, tradeAt: time, price, volume, bid, ask, bidQty, askQty, oi, atp, ltq, totalBuyQty, totalSellQty, prevClose, depth, iv, delta, theta, gamma, vega, rho };
}

const BOOK = ["bid", "ask", "bidQty", "askQty", "oi"] as const;

/**
 * Keeps a row when something worth a record happened: the first sight of a key, a trade (price or cumulative volume moved), or, at most
 * once per `minGapMs`, a change in the book or open interest. A burst of depth flicker between two trades is thinned, a trade never is.
 */
export class FeedThrottle {
  private last = new Map<string, { row: FeedRow; keptAt: number }>();
  constructor(private minGapMs: number) {}

  keep(row: FeedRow): boolean {
    const prev = this.last.get(row.key);
    const trade = !prev || prev.row.price !== row.price || prev.row.volume !== row.volume;
    const book = !!prev && (BOOK.some((k) => prev.row[k] !== row[k]) || JSON.stringify(prev.row.depth) !== JSON.stringify(row.depth));
    if (!trade && !(book && row.recvAt - prev!.keptAt >= this.minGapMs)) return false;
    this.last.set(row.key, { row, keptAt: row.recvAt });
    return true;
  }
}
