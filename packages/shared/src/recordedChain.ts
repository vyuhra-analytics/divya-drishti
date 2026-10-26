// A chain read back from our own `quote_snapshots`: the same `Chain` the live panel draws, for any moment we recorded. Pure, so the mapping from
// stored rows to a chain (spot from the settling future, bid/ask from the book, OI change against the first snapshot of the day) is tested.
import { atmStrike, maxPain, pcr, pickStrikes, type Chain, type ChainRow, type OptionLeg } from "./options";

export interface SnapshotContract {
  key: string;
  side: "CE" | "PE" | "FUT";
  /** YYYY-MM-DD */
  expiry: string;
  strike: number;
  lot?: number | null;
  /** for an option, the key of the future it settles against */
  underlyingKey?: string | null;
  lastPrice?: number | null;
  netChange?: number | null;
  oi?: number | null;
  volume?: number | null;
  iv?: number | null;
  delta?: number | null;
  theta?: number | null;
  gamma?: number | null;
  vega?: number | null;
  lowerCircuit?: number | null;
  upperCircuit?: number | null;
  depth?: { buy?: { quantity: number; price: number }[]; sell?: { quantity: number; price: number }[] } | null;
}

const v = (x: number | null | undefined) => (x === null || x === undefined ? undefined : x);
const best = (side: { quantity: number; price: number }[] | undefined) => side?.find((l) => l.price > 0 && l.quantity > 0);

function leg(c: SnapshotContract, baseline: Map<string, number> | undefined): OptionLeg {
  const bid = best(c.depth?.buy);
  const ask = best(c.depth?.sell);
  const base = baseline?.get(c.key);
  const oi = v(c.oi);
  const traded = c.lastPrice !== null && c.lastPrice !== undefined && c.lastPrice > 0;
  return {
    key: c.key,
    ukey: c.key,
    ltp: traded ? c.lastPrice! : undefined,
    change: traded ? v(c.netChange) : undefined,
    bid: bid?.price,
    ask: ask?.price,
    bidQty: bid?.quantity,
    askQty: ask?.quantity,
    oi,
    volume: v(c.volume),
    iv: v(c.iv),
    delta: v(c.delta),
    theta: v(c.theta),
    gamma: v(c.gamma),
    vega: v(c.vega),
    lowerCircuit: v(c.lowerCircuit),
    upperCircuit: v(c.upperCircuit),
    prevOi: base,
    oiChange: base !== undefined && oi !== undefined ? oi - base : undefined,
  };
}

/**
 * `rows` are the options of one underlying (all expiries) and its futures at one snapshot. `baseline` maps a contract key to its OI in the first
 * snapshot of the same IST day (absent for that first snapshot itself: there is nothing to compare with).
 */
export function recordedChain(input: {
  underlying: string;
  expiry?: string;
  asOf: number;
  rows: SnapshotContract[];
  baseline?: Map<string, number>;
  strikesEachSide?: number;
  prevAt?: number | null;
  nextAt?: number | null;
}): Chain | undefined {
  const options = input.rows.filter((r) => r.side !== "FUT");
  const expiries = [...new Set(options.map((r) => r.expiry))].sort();
  const expiry = input.expiry && expiries.includes(input.expiry) ? input.expiry : expiries[0];
  if (!expiry) return undefined;
  const ofExpiry = options.filter((r) => r.expiry === expiry);
  const future = input.rows.find((r) => r.side === "FUT" && r.key === ofExpiry[0].underlyingKey);
  const fBid = best(future?.depth?.buy)?.price;
  const fAsk = best(future?.depth?.sell)?.price;
  const spot = future?.lastPrice && future.lastPrice > 0 ? future.lastPrice : fBid && fAsk ? (fBid + fAsk) / 2 : undefined;

  const strikes = [...new Set(ofExpiry.map((r) => r.strike))].sort((a, b) => a - b);
  const chosen = new Set(pickStrikes(strikes, spot ?? strikes[Math.floor(strikes.length / 2)], input.strikesEachSide ?? 10));
  const rows: ChainRow[] = [...chosen]
    .sort((a, b) => a - b)
    .map((strike) => ({
      strike,
      ce: ofExpiry.filter((r) => r.strike === strike && r.side === "CE").map((r) => leg(r, input.baseline))[0],
      pe: ofExpiry.filter((r) => r.strike === strike && r.side === "PE").map((r) => leg(r, input.baseline))[0],
    }));
  return {
    underlying: input.underlying,
    expiry,
    expiries,
    spot,
    atm: spot === undefined ? undefined : atmStrike([...chosen], spot),
    lot: v(ofExpiry[0].lot),
    pcr: pcr(rows),
    maxPain: maxPain(rows),
    rows,
    updatedAt: input.asOf,
    source: "upstox",
    oiBasis: input.baseline ? "session-open" : undefined,
    asOf: input.asOf,
    prevAt: input.prevAt ?? null,
    nextAt: input.nextAt ?? null,
  };
}
