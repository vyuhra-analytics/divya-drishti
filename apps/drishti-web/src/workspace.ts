import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LayoutItem } from "react-grid-layout";
import type { Timeframe } from "@drishti/shared";
import { useSettings } from "./settings";

export type WidgetType = "chart" | "quote" | "watchlist" | "tv";
export const GROUPS = ["amber", "blue", "green", "red"] as const;
export type Group = (typeof GROUPS)[number];

/** group === null means pinned: the widget shows its own `symbol` instead of following a link group. */
export interface Widget {
  id: string;
  type: WidgetType;
  group: Group | null;
  symbol: string;
  tf: Timeframe;
  /** tv widgets: selected stream URL */
  channel?: string;
}

interface WorkspaceState {
  widgets: Widget[];
  layout: LayoutItem[];
  groups: Record<Group, string>;
  focusedId: string | null;
  paletteOpen: boolean;
  addWidget: (type: WidgetType, symbol?: string) => void;
  removeWidget: (id: string) => void;
  setLayout: (layout: readonly LayoutItem[]) => void;
  cycleGroup: (id: string) => void;
  loadSymbol: (id: string, symbol: string) => void;
  setTf: (id: string, tf: Timeframe) => void;
  setChannel: (id: string, channel: string) => void;
  focus: (id: string) => void;
  setPaletteOpen: (open: boolean) => void;
  reset: () => void;
}

export const SIZE: Record<WidgetType, { w: number; h: number }> = {
  chart: { w: 8, h: 12 },
  quote: { w: 4, h: 5 },
  watchlist: { w: 4, h: 7 },
  tv: { w: 5, h: 9 },
};

const defaults = () => ({
  widgets: [
    { id: "chart-1", type: "chart", group: "amber", symbol: "NIFTY", tf: "1m" },
    { id: "quote-1", type: "quote", group: "amber", symbol: "NIFTY", tf: "1m" },
    { id: "watch-1", type: "watchlist", group: "amber", symbol: "NIFTY", tf: "1m" },
    { id: "chart-2", type: "chart", group: null, symbol: "BANKNIFTY", tf: "5m" },
  ] satisfies Widget[] as Widget[],
  layout: [
    { i: "chart-1", x: 0, y: 0, w: 8, h: 12 },
    { i: "quote-1", x: 8, y: 0, w: 4, h: 5 },
    { i: "watch-1", x: 8, y: 5, w: 4, h: 7 },
    { i: "chart-2", x: 0, y: 12, w: 12, h: 9 },
  ],
  groups: { amber: "NIFTY", blue: "RELIANCE", green: "TCS", red: "INFY" } as Record<Group, string>,
  focusedId: "chart-1" as string | null,
});

export const symbolOf = (w: Widget, groups: Record<Group, string>) => (w.group ? groups[w.group] : w.symbol);

const patch = (widgets: Widget[], id: string, change: Partial<Widget>) =>
  widgets.map((w) => (w.id === id ? { ...w, ...change } : w));

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      ...defaults(),
      paletteOpen: false,

      addWidget: (type, symbol) =>
        set((s) => {
          const focused = s.widgets.find((w) => w.id === s.focusedId);
          const id = `${type}-${Date.now().toString(36)}`;
          const tf = useSettings.getState().defaultTf;
          // explicit symbol → pinned to it; otherwise join the focused widget's group
          const widget: Widget = symbol
            ? { id, type, group: null, symbol, tf }
            : {
                id,
                type,
                group: focused?.group ?? "amber",
                symbol: focused ? symbolOf(focused, s.groups) : s.groups.amber,
                tf,
              };
          const bottom = s.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
          return {
            widgets: [...s.widgets, widget],
            layout: [...s.layout, { i: id, x: 0, y: bottom, ...SIZE[type] }],
            focusedId: id,
          };
        }),

      removeWidget: (id) =>
        set((s) => ({
          widgets: s.widgets.filter((w) => w.id !== id),
          layout: s.layout.filter((l) => l.i !== id),
          focusedId: s.focusedId === id ? null : s.focusedId,
        })),

      setLayout: (layout) => set({ layout: layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })) }),

      cycleGroup: (id) =>
        set((s) => {
          const w = s.widgets.find((x) => x.id === id);
          if (!w) return {};
          const order: (Group | null)[] = [...GROUPS, null];
          const group = order[(order.indexOf(w.group) + 1) % order.length];
          // keep showing the same symbol when unpinning from a group
          return { widgets: patch(s.widgets, id, { group, symbol: symbolOf(w, s.groups) }) };
        }),

      loadSymbol: (id, symbol) =>
        set((s) => {
          const w = s.widgets.find((x) => x.id === id);
          if (!w) return {};
          return w.group
            ? { groups: { ...s.groups, [w.group]: symbol } }
            : { widgets: patch(s.widgets, id, { symbol }) };
        }),

      setTf: (id, tf) => set((s) => ({ widgets: patch(s.widgets, id, { tf }) })),
      setChannel: (id, channel) => set((s) => ({ widgets: patch(s.widgets, id, { channel }) })),
      focus: (focusedId) => set({ focusedId }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      reset: () => set(defaults()),
    }),
    {
      name: "drishti-workspace",
      version: 1,
      migrate: () => defaults(), // ponytail: any schema change resets the layout; write real migrations once layouts are worth keeping
      partialize: ({ widgets, layout, groups, focusedId }) => ({ widgets, layout, groups, focusedId }),
    },
  ),
);

export function useWidgetSymbol(w: Widget) {
  return useWorkspace((s) => symbolOf(w, s.groups));
}
