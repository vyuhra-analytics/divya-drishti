// Cost profiles per broker. The statutory charges on MCX (exchange transaction charge, CTT, SEBI fee, stamp duty, GST) are the exchange's and the
// government's and so the same at every broker; what differs is the brokerage rule. Each profile says where its numbers come from and how far to
// trust them: only Upstox can be checked against the broker's own calculation (its Brokerage Details API, `upstoxCharges.ts`).
import { currentRates, UPSTOX_MCX_RATES, legCosts, roundTrip, type CostBreakdown, type CostRates, type Kind, type Side } from "./costs";

/** how far a profile's numbers can be trusted */
export type Verification =
  /** checked against the broker's own charge calculation, leg by leg, in a contract test and a live check */
  | "api"
  /** copied from the broker's own published pricing page on the date given; not compared with a contract note */
  | "published"
  /** from third-party sites that disagree or are out of date: a starting point, to be checked on the broker's page and a contract note */
  | "unverified"
  /** the user's own numbers */
  | "custom";

export interface BrokerProfile {
  id: string;
  name: string;
  rates: CostRates;
  verification: Verification;
  /** where the numbers come from, in a sentence */
  source: string;
  /** when it was read (YYYY-MM-DD); empty for a custom profile */
  checkedOn: string;
  /** what to be careful about */
  note?: string;
}

// The rates are built on first use, not when this file loads: costs.ts and the package index import each other, and reading
// UPSTOX_MCX_RATES while the cycle is still loading would see it undefined. Each profile's `rates` is a getter for the same reason.
let zerodhaRates: CostRates | undefined;
let kotakRates: CostRates | undefined;
/** Zerodha's published MCX schedule matched our statutory table on every line; only the brokerage rule differs. */
const zerodha = (): CostRates => (zerodhaRates ??= { ...UPSTOX_MCX_RATES, brokerageFlat: 20, brokeragePctFutures: 0.0003, brokeragePctOptions: 0 });
/** Kotak Neo: the flat brokerage aggregators report; statutory charges as the MCX schedule (Kotak's FAQ shows 0.0026% / 0.05% exchange charges, which do not match the MCX schedule our other profiles use). */
const kotak = (): CostRates => (kotakRates ??= { ...UPSTOX_MCX_RATES, brokerageFlat: 10 });

export const BROKERS: BrokerProfile[] = [
  {
    id: "upstox",
    name: "Upstox",
    get rates() {
      return UPSTOX_MCX_RATES;
    },
    verification: "api",
    source: "Upstox's own Brokerage Details API, six legs recorded and replayed in a contract test; re-check any time with the Check with Upstox button",
    checkedOn: "2026-10-22",
    note: "Rs 30 per order is what the API charged this account; it may be plan-specific.",
  },
  {
    id: "zerodha",
    name: "Zerodha",
    get rates() {
      return zerodha();
    },
    verification: "published",
    source: "zerodha.com/charges, commodities: futures 0.03% or Rs 20 per executed order, whichever is lower; options Rs 20 per executed order; MCX 0.0021% futures and 0.0418% options; CTT 0.01% futures and 0.05% options on the sell side; SEBI Rs 10 per crore; stamp duty 0.002% and 0.003% on the buy side; GST 18% on brokerage, SEBI and transaction charges",
    checkedOn: "2026-10-22",
    note: "Not compared with a Zerodha contract note.",
  },
  {
    id: "kotakneo",
    name: "Kotak Neo",
    get rates() {
      return kotak();
    },
    verification: "published",
    source: "kotakneo.com/pricing: Rs 10 per order for F&O carry-forward, and Rs 10 or 0.05% (whichever is lower) intraday, on Trade Free Youth, Trade Free and Trade Free Pro; the page does not name MCX",
    checkedOn: "2026-10-22",
    note: "The official kotakneo.com page lists F&O rates but does not say they apply to MCX commodities, and shows no exchange or statutory charges (it only links a charges PDF), so those are the MCX schedule our other profiles use. At crude lot sizes 0.05% of turnover is above Rs 10, so the flat Rs 10 is what applies. Check the charges PDF and a contract note before relying on it.",
  },
  {
    id: "custom",
    name: "Custom",
    get rates() {
      return UPSTOX_MCX_RATES;
    },
    verification: "custom",
    source: "your own rates, edited in the Costs panel",
    checkedOn: "",
  },
];

export const DEFAULT_BROKER = "upstox";

export const brokerById = (id: string | undefined): BrokerProfile | undefined => BROKERS.find((b) => b.id === id);

/** The profile whose rates exactly equal `rates`, if any (custom is never matched): how the panel knows an edit has made the rates "custom". */
export function matchBroker(rates: CostRates): BrokerProfile | undefined {
  const keys = Object.keys(UPSTOX_MCX_RATES) as (keyof CostRates)[];
  return BROKERS.find((b) => b.id !== "custom" && keys.every((k) => b.rates[k] === rates[k]));
}

/** A saved or server-stored rates object with every field present, an untouched old Upstox table upgraded (`currentRates`), unknown or missing fields defaulted. */
export const normalizeRates = (saved: Partial<CostRates> | undefined | null): CostRates => currentRates({ ...UPSTOX_MCX_RATES, ...(saved ?? {}) });

export interface BrokerComparison {
  broker: BrokerProfile;
  /** all charges for the round trip, rupees */
  costs: number;
  net: number;
  /** points the price must move for the trade to pay its costs */
  breakeven: number;
  entryLeg: CostBreakdown;
}

/** The same trade at every broker: entry and exit prices, units per lot and lots. Cheapest first. */
export function compareBrokers(kind: Kind, side: Side, entry: number, exit: number, units: number, lots: number): BrokerComparison[] {
  return BROKERS.filter((b) => b.id !== "custom")
    .map((broker) => {
      const trip = roundTrip(kind, side, entry, exit, units, lots, broker.rates);
      return { broker, costs: trip.costs.total, net: trip.net, breakeven: trip.breakevenPoints, entryLeg: legCosts(kind, side, entry, units, lots, broker.rates) };
    })
    .sort((a, b) => a.costs - b.costs);
}
