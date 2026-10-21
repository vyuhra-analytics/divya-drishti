import { create } from "zustand";
import { persist } from "zustand/middleware";
import { closePaper, exitHit, instrument, lotUnits, openPaper, UPSTOX_MCX_RATES, type CostRates, type ExitReason, type PaperPosition, type PaperTrade, type Side } from "@drishti/shared";
import { isLive } from "./market";
import { useStore } from "./store";

export const MAX_TRADES = 500;
const COSTS_KEY = "drishti-costs"; // the rates edited in the Costs panel

/** The cost rates the user saved in the Costs panel (so paper results use the same numbers), else the Upstox defaults. */
export function costRates(): CostRates {
  try {
    const saved = JSON.parse(localStorage.getItem(COSTS_KEY) ?? "null");
    return { ...UPSTOX_MCX_RATES, ...(saved?.rates ?? {}) };
  } catch {
    return UPSTOX_MCX_RATES;
  }
}

interface PaperState {
  capital: number;
  /** price points against you on every fill */
  slippage: number;
  positions: PaperPosition[];
  /** newest first */
  trades: PaperTrade[];
  setCapital: (n: number) => void;
  setSlippage: (n: number) => void;
  /** returns an error message, or undefined when the order filled */
  place: (symbol: string, side: Side, lots: number, stop?: number, target?: number) => string | undefined;
  close: (id: string, reason?: ExitReason) => void;
  setNote: (tradeId: string, note: string) => void;
  reset: () => void;
}

const newId = () => `pp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Paper account kept in this browser: positions, journal of closed trades, capital. Simulated only; nothing reaches a broker. */
export const usePaper = create<PaperState>()(
  persist(
    (set, get) => ({
      capital: 500_000,
      slippage: 1,
      positions: [],
      trades: [],
      setCapital: (capital) => set({ capital: Math.max(0, capital) }),
      setSlippage: (slippage) => set({ slippage: Math.max(0, slippage) }),
      place: (symbol, side, lots, stop, target) => {
        const units = lotUnits(symbol);
        if (instrument(symbol)?.exchange !== "MCX" || units === undefined) return "Paper trading uses Upstox's MCX costs: pick an MCX contract.";
        if (get().positions.some((p) => p.symbol === symbol)) return "Already in this contract: close that position first.";
        const q = useStore.getState().quotes[symbol];
        if (!q) return "No live price for this contract yet.";
        if (!isLive(symbol)) return "The market is closed or the feed is stale: paper orders fill only on a live price.";
        const filled = openPaper({ id: newId(), symbol, side, lots, units, stop, target }, q, get().slippage, Date.now());
        if ("error" in filled) return filled.error;
        set((s) => ({ positions: [...s.positions, filled] }));
        return undefined;
      },
      close: (id, reason = "manual") => {
        const p = get().positions.find((x) => x.id === id);
        const q = p && useStore.getState().quotes[p.symbol];
        if (!p || !q) return;
        const trade = closePaper(p, q, get().slippage, Date.now(), reason, costRates());
        set((s) => ({ positions: s.positions.filter((x) => x.id !== id), trades: [trade, ...s.trades].slice(0, MAX_TRADES) }));
      },
      setNote: (tradeId, note) => set((s) => ({ trades: s.trades.map((t) => (t.id === tradeId ? { ...t, note: note.slice(0, 500) } : t)) })),
      reset: () => set({ positions: [], trades: [] }),
    }),
    { name: "drishti-paper", version: 1 },
  ),
);

/** Closes paper positions when a live price reaches their stop or target, for as long as the app is open. Returns a stop function. */
export function startPaperEngine() {
  return useStore.subscribe((s, p) => {
    if (s.quotes === p.quotes) return;
    const { positions, close } = usePaper.getState();
    for (const pos of positions) {
      const q = s.quotes[pos.symbol];
      if (!q || !isLive(pos.symbol)) continue; // a stale or closed market does not trigger anything
      const hit = exitHit(pos, q.price);
      if (hit) close(pos.id, hit);
    }
  });
}
