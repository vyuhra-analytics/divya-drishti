// Upstox's own charge calculation (GET /v2/charges/brokerage), parsed into our cost shape, and the comparison with our table.
// This is the authority for what a leg costs on this account: the cost table in costs.ts is checked against it, not the other way round.
import type { CostBreakdown } from "./costs";
import type { Side } from "./costs";

export interface UpstoxCharges {
  total: number;
  brokerage: number;
  gst: number;
  /** securities / commodities transaction tax (Upstox calls it stt) */
  ctt: number;
  exchange: number;
  sebi: number;
  stamp: number;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The `data.charges` block of a brokerage response; undefined when any figure is missing, so a changed format is never read as zero charges. */
export function parseUpstoxCharges(json: any): UpstoxCharges | undefined {
  const c = json?.data?.charges;
  if (!c || typeof c !== "object") return undefined;
  const other = c.otherTaxes ?? c.other_charges;
  const v = {
    total: num(c.total),
    brokerage: num(c.brokerage),
    gst: num(c.taxes?.gst),
    ctt: num(c.taxes?.stt),
    exchange: num(other?.transaction),
    sebi: num(other?.sebi_turnover),
    stamp: num(c.taxes?.stamp_duty),
  };
  return Object.values(v).every((x) => x !== undefined) ? (v as UpstoxCharges) : undefined;
}

/** The request for one order: `key` is an Upstox instrument key (MCX_FO|573422), `quantity` in units, `price` the traded price (an option's premium). */
export const upstoxChargesUrl = (key: string, quantity: number, price: number, side: Side) =>
  `https://api.upstox.com/v2/charges/brokerage?instrument_token=${encodeURIComponent(key)}&quantity=${quantity}&product=I&transaction_type=${side === "buy" ? "BUY" : "SELL"}&price=${price}`;

export interface CostCheck {
  upstox: UpstoxCharges;
  ours: CostBreakdown;
  /** our total minus Upstox's, rupees (positive = we charge more than Upstox) */
  diff: number;
  agree: boolean;
}

/** Compare one leg: `agree` when the totals are within `tolerance` rupees (default Re 1; Upstox rounds each line to paise). */
export function compareCosts(upstox: UpstoxCharges, ours: CostBreakdown, tolerance = 1): CostCheck {
  const diff = Math.round((ours.total - upstox.total) * 100) / 100;
  return { upstox, ours, diff, agree: Math.abs(diff) <= tolerance };
}
