import { ENERGY_UNIVERSE, type UniverseItem } from "@drishti/shared";
import { useStore } from "./store";

export interface UniverseView extends UniverseItem {
  price?: number;
  changePct?: number;
  volume?: number;
  marketCap?: number;
  high52?: number;
  low52?: number;
  /** seconds behind the exchange; 0 = live */
  delayedBy: number;
}

/**
 * Universe rows for the heatmap / screener. The six instruments we stream live use their live quote
 * (change vs previous close) instead of the 10 s scanner snapshot.
 */
export function useUniverse(): UniverseView[] {
  const universe = useStore((s) => s.universe);
  const quotes = useStore((s) => s.quotes);
  return ENERGY_UNIVERSE.map((item) => {
    const row = universe[item.tv];
    const q = item.symbol ? quotes[item.symbol] : undefined;
    if (q) {
      const changePct = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : row?.changePct;
      return { ...item, price: q.price, changePct, volume: q.volume ?? row?.volume, high52: row?.high52, low52: row?.low52, marketCap: row?.marketCap, delayedBy: q.delayedBy };
    }
    return { ...item, price: row?.price, changePct: row?.changePct, volume: row?.volume, marketCap: row?.marketCap, high52: row?.high52, low52: row?.low52, delayedBy: row?.delayedBy ?? 0 };
  });
}

/** % change → fill colour: diverging around 0, saturating at ±3%; follows the up/down colour setting via CSS vars. */
export function heatColor(pct: number | undefined): string {
  if (pct === undefined) return "var(--hover)";
  const strength = Math.min(1, Math.abs(pct) / 3);
  const base = pct >= 0 ? "var(--up)" : "var(--down)";
  return `color-mix(in srgb, ${base} ${Math.round(15 + strength * 70)}%, var(--panel))`;
}
