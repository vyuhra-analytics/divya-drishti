import type { IndicatorDescriptor } from "openalgo-charts";
import type { Tier2Context, Tier2Descriptor, Tier2Point } from "openalgo-charts/indicators";
import type { FlowBucket } from "@drishti/shared";
import { apiUrl } from "./settings";

// ESTIMATED order flow on the advanced chart: two studies that take their data from our own recording of the Upstox feed (`GET /feed/flow`)
// instead of from the chart's bars (openalgo-charts' Tier-2 contract). Delta is buy minus sell volume per candle, from comparing each trade with
// the quote before it; the book study is resting bid size against ask size. Both are estimates (Upstox sends no trade tape): the titles say so.

export const DELTA_ID = "drishti-flow-delta";
export const BOOK_ID = "drishti-flow-book";

/** the chart intervals the flow route can bucket */
const TF_SECONDS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 };
/** the route serves at most two days per request */
const WINDOW_S = 47 * 3600;
const LIVE_POLL_MS = 10_000;

/** Buy-side bars above the zero line and sell-side bars below it: a histogram has one colour, so the two halves are two plots. */
export const deltaPoints = (buckets: readonly FlowBucket[]): Tier2Point[] =>
  buckets.map((b) => ({ time: b.time, values: { up: b.delta > 0 ? b.delta : 0, down: b.delta < 0 ? b.delta : 0 } }));

export const bookPoints = (buckets: readonly FlowBucket[]): Tier2Point[] => buckets.flatMap((b) => (b.imbalance === undefined ? [] : [{ time: b.time, values: { book: b.imbalance } }]));

/** The buckets of one MCX contract between two instants (UTC seconds), at the chart's own interval; empty for anything the route cannot serve. */
export async function loadFlow(symbol: string | undefined, interval: string | undefined, from: number, to: number, signal?: AbortSignal): Promise<FlowBucket[]> {
  const step = interval ? TF_SECONDS[interval] : undefined;
  if (!symbol?.startsWith("MCX:") || !step || !(to > 0)) return [];
  const start = Math.max(from, to + step - WINDOW_S);
  const res = await fetch(`${apiUrl()}/feed/flow?key=${encodeURIComponent(symbol)}&from=${start * 1000}&to=${(to + step) * 1000}&tf=${interval}`, { signal });
  return res.ok ? (((await res.json()) as { buckets?: FlowBucket[] }).buckets ?? []) : [];
}

const supports = (ctx: Tier2Context) => ctx.dataContext?.symbol?.startsWith("MCX:") === true && ctx.dataContext.interval !== undefined && ctx.dataContext.interval in TF_SECONDS;

function study(id: string, name: string, plots: Tier2Descriptor["plots"], toPoints: (b: readonly FlowBucket[]) => Tier2Point[], extra: Partial<Tier2Descriptor> = {}): Tier2Descriptor {
  return {
    id,
    name,
    category: "Order flow (estimated)",
    placement: "pane",
    inputs: [],
    plots,
    supports,
    fetch: async (ctx) => toPoints(await loadFlow(ctx.dataContext?.symbol, ctx.dataContext?.interval, ctx.from, ctx.to, ctx.signal)),
    // the newest candles again every few seconds: a point with the same time replaces the one before it
    subscribe: (ctx, push) => {
      const id = setInterval(() => {
        const now = Math.floor(Date.now() / 1000);
        const step = TF_SECONDS[ctx.dataContext?.interval ?? ""] ?? 300;
        void loadFlow(ctx.dataContext?.symbol, ctx.dataContext?.interval, now - 3 * step, now)
          .then((b) => toPoints(b).forEach(push))
          .catch(() => undefined);
      }, LIVE_POLL_MS);
      return () => clearInterval(id);
    },
    ...extra,
  };
}

export const flowStudies = (): Tier2Descriptor[] => [
  study(
    DELTA_ID,
    "Delta (estimated)",
    [
      { key: "up", type: "histogram", title: "Buy volume", style: { color: "#26a69a" } as never },
      { key: "down", type: "histogram", title: "Sell volume", style: { color: "#ef5350" } as never },
    ],
    deltaPoints,
  ),
  study(BOOK_ID, "Book imbalance (estimated)", [{ key: "book", type: "line", title: "Bid minus ask size" }], bookPoints, { range: () => ({ min: -1, max: 1 }), levels: () => [{ value: 0 } as never] }),
];

/** Registers the studies once. The library's functions are passed in so this file never imports the (lazy, heavy) library itself; any failure leaves the chart as it was. */
export function registerFlowStudies(register: (d: IndicatorDescriptor) => void, create: (d: Tier2Descriptor) => IndicatorDescriptor, has: (id: string) => boolean): void {
  try {
    for (const d of flowStudies()) if (!has(d.id)) register(create(d));
  } catch (e) {
    console.warn("order flow studies not registered:", (e as Error).message);
  }
}
