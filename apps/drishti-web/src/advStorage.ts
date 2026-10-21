import { createIndexedDbWidgetStorage, stripView, type AsyncStorageLike } from "openalgo-charts/widget";

/**
 * A saved chart state restored onto a different dataset (another desk, a symbol change, a day of new bars) must not bring the
 * old view with it: a pinned price range or viewport from crude oil at 9,300 leaves natural gas at 280 off screen and the chart
 * blank. Drawings, indicators, chart type and pane layout stay; the viewport and pinned ranges go, and the symbol is the one
 * this panel is showing now.
 */
export function sanitizeSavedState(json: string, symbol: string, exchange: string): string {
  try {
    const state = JSON.parse(json);
    if (!state || typeof state !== "object" || !state.chart) return json;
    return JSON.stringify({ ...state, symbol, exchange, chart: stripView(state.chart) });
  } catch {
    return json; // unreadable: let the library deal with it as before
  }
}

/** The library's IndexedDB store (its default database, so earlier saves keep working) with saved widget states sanitised on read. */
export function advStorage(symbol: string, exchange: string): AsyncStorageLike | undefined {
  if (typeof indexedDB === "undefined") return undefined;
  const base = createIndexedDbWidgetStorage(indexedDB, "openalgo-charts-widget");
  return {
    entries: async (prefix) => (await base.entries(prefix)).map(([k, v]) => [k, k.endsWith(":state") ? sanitizeSavedState(v, symbol, exchange) : v] as const),
    setItem: (k, v) => base.setItem(k, v),
    removeItem: (k) => base.removeItem(k),
    journal: base.journal,
    subscribe: base.subscribe?.bind(base),
  } as AsyncStorageLike;
}
