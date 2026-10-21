import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LayoutItem } from "react-grid-layout";
import type { Timeframe } from "@drishti/shared";
import { useSettings } from "./settings";
import type { ChartType, Indicator } from "./Chart";
import { cleanName, MAX_SAVED, PRESETS, type Snapshot } from "./presets";

export type WidgetType = "chart" | "quote" | "watchlist" | "tv" | "news" | "heatmap" | "screener" | "options" | "insider" | "calendar" | "alerts" | "advchart" | "briefing" | "cot" | "chokepoints" | "curve";
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
  /** chart widgets: series type and enabled indicators (defaults: candles + volume) */
  chartType?: ChartType;
  indicators?: Indicator[];
}

interface WorkspaceState {
  widgets: Widget[];
  layout: LayoutItem[];
  groups: Record<Group, string>;
  focusedId: string | null;
  paletteOpen: boolean;
  /** user-saved workspaces by name, and the name of the one loaded last (null = the untouched default) */
  saved: Record<string, Snapshot>;
  activeWorkspace: string | null;
  saveWorkspace: (name: string) => boolean;
  loadWorkspace: (key: string) => void;
  deleteWorkspace: (name: string) => void;
  addWidget: (type: WidgetType, symbol?: string) => void;
  removeWidget: (id: string) => void;
  setLayout: (layout: readonly LayoutItem[]) => void;
  cycleGroup: (id: string) => void;
  loadSymbol: (id: string, symbol: string) => void;
  setTf: (id: string, tf: Timeframe) => void;
  setChannel: (id: string, channel: string) => void;
  updateWidget: (id: string, change: Partial<Pick<Widget, "chartType" | "indicators">>) => void;
  focus: (id: string) => void;
  setPaletteOpen: (open: boolean) => void;
  reset: () => void;
}

export const SIZE: Record<WidgetType, { w: number; h: number }> = {
  chart: { w: 8, h: 12 },
  quote: { w: 4, h: 9 },
  watchlist: { w: 4, h: 7 },
  tv: { w: 5, h: 9 },
  news: { w: 5, h: 10 },
  heatmap: { w: 6, h: 12 },
  screener: { w: 7, h: 12 },
  options: { w: 7, h: 14 },
  insider: { w: 7, h: 12 },
  calendar: { w: 6, h: 14 },
  alerts: { w: 5, h: 12 },
  advchart: { w: 8, h: 16 },
  briefing: { w: 6, h: 16 },
  cot: { w: 7, h: 17 },
  chokepoints: { w: 6, h: 16 },
  curve: { w: 6, h: 18 },
};

const defaults = () => ({
  widgets: [
    { id: "chart-1", type: "advchart", group: "amber", symbol: "MCX:CRUDEOIL", tf: "1m" },
    { id: "quote-1", type: "quote", group: "amber", symbol: "MCX:CRUDEOIL", tf: "1m" },
    { id: "watch-1", type: "watchlist", group: "amber", symbol: "MCX:CRUDEOIL", tf: "1m" },
    { id: "chart-2", type: "advchart", group: "blue", symbol: "NYMEX:CL", tf: "5m" },
    { id: "chart-3", type: "advchart", group: null, symbol: "MCX:NATURALGAS", tf: "5m" },
  ] satisfies Widget[] as Widget[],
  layout: [
    { i: "chart-1", x: 0, y: 0, w: 8, h: 12 },
    { i: "quote-1", x: 8, y: 0, w: 4, h: 9 },
    { i: "watch-1", x: 8, y: 9, w: 4, h: 9 },
    { i: "chart-2", x: 0, y: 12, w: 4, h: 10 },
    { i: "chart-3", x: 4, y: 12, w: 4, h: 10 },
  ],
  groups: { amber: "MCX:CRUDEOIL", blue: "NYMEX:CL", green: "MCX:NATURALGAS", red: "NYMEX:NG" } as Record<Group, string>,
  focusedId: "chart-1" as string | null,
});

export const symbolOf = (w: Widget, groups: Record<Group, string>) => (w.group ? groups[w.group] : w.symbol);

const patch = (widgets: Widget[], id: string, change: Partial<Widget>) =>
  widgets.map((w) => (w.id === id ? { ...w, ...change } : w));

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      ...defaults(),
      paletteOpen: false,
      saved: {},
      activeWorkspace: null,

      // key = "preset:<key>" or "saved:<name>"; a copy is applied, so editing the live layout never touches the stored one
      loadWorkspace: (key) =>
        set((s) => {
          const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
          const found = kind === "preset" ? PRESETS.find((p) => p.key === id) : undefined;
          const snap = found ? found.build() : kind === "saved" ? s.saved[id] : undefined;
          if (!snap) return {};
          return { ...structuredClone(snap), activeWorkspace: found ? found.name : id };
        }),

      saveWorkspace: (name) => {
        const clean = cleanName(name);
        const { saved, widgets, layout, groups, focusedId } = get();
        const taken = PRESETS.some((p) => p.name.toLowerCase() === clean.toLowerCase());
        if (!clean || taken || (!(clean in saved) && Object.keys(saved).length >= MAX_SAVED)) return false;
        set({ saved: { ...saved, [clean]: structuredClone({ widgets, layout, groups, focusedId }) }, activeWorkspace: clean });
        return true;
      },

      deleteWorkspace: (name) =>
        set((s) => {
          const { [name]: _gone, ...rest } = s.saved;
          return { saved: rest, activeWorkspace: s.activeWorkspace === name ? null : s.activeWorkspace };
        }),

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
      updateWidget: (id, change) => set((s) => ({ widgets: patch(s.widgets, id, change) })),
      focus: (focusedId) => set({ focusedId }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      reset: () => set({ ...defaults(), activeWorkspace: null }),
    }),
    {
      name: "drishti-workspace",
      version: 2,
      migrate: () => defaults(), // ponytail: any schema change resets the layout (v2: equity mocks → energy futures); write real migrations once layouts are worth keeping
      partialize: ({ widgets, layout, groups, focusedId, saved, activeWorkspace }) => ({ widgets, layout, groups, focusedId, saved, activeWorkspace }),
    },
  ),
);

export function useWidgetSymbol(w: Widget) {
  return useWorkspace((s) => symbolOf(w, s.groups));
}
