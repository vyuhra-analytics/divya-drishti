import { useEffect } from "react";
import { create } from "zustand";

// Levels a panel wants on the chart (the range, the entry, the stop, the targets): a panel PUBLISHES them here and the "Strategy levels" study of the advanced
// chart draws them as price lines, so the trader reads the levels where the price is. A panel sets its own source and the lines of that source are replaced
// whenever it publishes again; leaving clears them.

export interface LevelInput {
  price: number;
  title: string;
  color: string;
  style?: "solid" | "dashed" | "dotted";
}

interface LevelsState {
  sources: Record<string, LevelInput[]>;
  set: (source: string, levels: LevelInput[]) => void;
}

export const useLevels = create<LevelsState>()((set) => ({
  sources: {},
  set: (source, levels) =>
    set((s) => {
      const next = { ...s.sources };
      if (levels.length) next[source] = levels;
      else delete next[source];
      return { sources: next };
    }),
}));

/** The lines of a panel, kept in step with its numbers (a NaN or missing price is left out) and cleared when it goes. */
export function usePublishLevels(source: string, levels: (LevelInput | undefined)[]) {
  const clean = levels.filter((l): l is LevelInput => !!l && Number.isFinite(l.price));
  const sig = JSON.stringify(clean);
  useEffect(() => {
    useLevels.getState().set(source, clean);
    return () => useLevels.getState().set(source, []);
  }, [source, sig]);
}
