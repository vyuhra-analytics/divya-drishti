import { describeProvenance, quoteProvenance, type Quote } from "@drishti/shared";
import { useFreshness } from "./market";
import { useStore } from "./store";

const SOURCE_LABEL: Record<Quote["source"], string> = { upstox: "UPSTOX", tradingview: "TV", yahoo: "YAHOO", demo: "DEMO" };

/**
 * Where a price comes from and how far to trust it: the source (DEMO = simulated), CLOSED / STALE, DELAYED, and FEEDS DIFFER when two live
 * feeds disagree. `compact` (watchlist rows) shows just the source, and a mark when the feeds disagree; the tooltip carries the detail.
 */
export function SourceBadge({ symbol, compact = false }: { symbol: string; compact?: boolean }) {
  const quote = useStore((s) => s.quotes[symbol]);
  const source = quote?.source;
  const delayedBy = quote?.delayedBy ?? 0;
  const fresh = useFreshness(symbol);
  if (!quote || !source) return null;
  const provenance = describeProvenance(quoteProvenance(quote, fresh), Date.now());
  if (compact) {
    return (
      <span className="badges mini">
        <span className={`badge src-${source}`} title={provenance}>
          {SOURCE_LABEL[source]}
        </span>
        {quote.drift && (
          <span className="badge disputed" title={`Two live feeds disagree: ${quote.drift.between.join(" and ")} differ by ${quote.drift.pct}%. This price may be wrong.`}>
            ≠
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="badges">
      {quote.drift && (
        <span className="badge disputed" title={`Two live feeds disagree: ${quote.drift.between.join(" and ")} differ by ${quote.drift.pct}% (${quote.drift.ticks} ticks). This price may be wrong.`}>
          FEEDS DIFFER
        </span>
      )}
      {fresh === "closed" && (
        <span className="badge closed" title="Exchange closed: showing the last price">
          CLOSED
        </span>
      )}
      {fresh === "stale" && (
        <span className="badge stale" title="Market open, but no update from the feed for over a minute">
          STALE
        </span>
      )}
      <span className={`badge src-${source}`} title={provenance}>
        {SOURCE_LABEL[source]}
      </span>
      {delayedBy > 0 && (
        <span className="badge delayed" title={`Exchange data delayed ${delayedBy / 60} minutes`}>
          DELAYED {delayedBy / 60}m
        </span>
      )}
    </span>
  );
}

/** Red strip across the top while any price on screen comes from the simulated demo feed (FEED=demo): none of it is a market price. */
export function SimulatedBanner() {
  const simulated = useStore((s) => Object.values(s.quotes).some((q) => q.source === "demo"));
  if (!simulated) return null;
  return (
    <div className="sim-banner" role="alert">
      <strong>SIMULATED PRICES</strong> The demo feed is on (FEED=demo in .env): these are not market prices. Do not trade from them.
    </div>
  );
}
