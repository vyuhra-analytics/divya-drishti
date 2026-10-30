import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LayoutItem } from "react-grid-layout";
import type { Timeframe } from "@drishti/shared";
import { useSettings } from "./settings";
import { cleanName, MAX_SAVED, PRESETS, type Snapshot } from "./presets";

export type WidgetType = "quote" | "watchlist" | "tv" | "news" | "calendar" | "alerts" | "advchart" | "briefing" | "cot" | "chokepoints" | "curve" | "eia" | "eiareport" | "drivers" | "labels" | "recap" | "costs" | "backtest" | "paper" | "quality" | "optionchain" | "optionhistory" | "reportday" | "usib" | "family" | "browser";
const GROUPS = ["amber", "blue", "green", "red"] as const;
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
  /** browser widgets: the address that is open */
  url?: string;
  /** chart widgets: series type and enabled indicators (defaults: candles + volume) */
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
  setChannel: (id: string, channel: string) => void;
  setUrl: (id: string, url: string) => void;
  focus: (id: string) => void;
  setPaletteOpen: (open: boolean) => void;
  reset: () => void;
}

/** Columns of the panel grid (Grid.tsx). A panel wider than this sends react-grid-layout into a render loop that crashes the tab. */
export const GRID_COLS = 12;

export const SIZE: Record<WidgetType, { w: number; h: number }> = {
  quote: { w: 4, h: 9 },
  watchlist: { w: 4, h: 7 },
  tv: { w: 5, h: 9 },
  news: { w: 5, h: 10 },
  calendar: { w: 6, h: 14 },
  alerts: { w: 5, h: 12 },
  advchart: { w: 8, h: 16 },
  briefing: { w: 6, h: 16 },
  cot: { w: 7, h: 17 },
  chokepoints: { w: 6, h: 16 },
  curve: { w: 6, h: 18 },
  eia: { w: 6, h: 17 },
  eiareport: { w: 6, h: 22 },
  reportday: { w: 5, h: 28 },
  usib: { w: 5, h: 28 },
  family: { w: 12, h: 28 },
  browser: { w: 7, h: 20 },
  drivers: { w: 3, h: 14 },
  labels: { w: 5, h: 15 },
  recap: { w: 6, h: 12 },
  costs: { w: 6, h: 20 },
  backtest: { w: 7, h: 26 },
  paper: { w: 7, h: 26 },
  quality: { w: 7, h: 26 },
  optionchain: { w: 12, h: 26 }, // the full grid width: the detailed chain needs it
  optionhistory: { w: 6, h: 16 },
};

/** First run, "Reset layout" and a damaged saved layout all start from the Evening desk (the first built-in desk). */
const defaults = () => {
  const { widgets, layout, groups, focusedId } = PRESETS[0].build();
  return { widgets, layout, groups, focusedId: focusedId as string | null };
};

let idSeq = 0;
const symbolOf = (w: Widget, groups: Record<Group, string>) => (w.group ? groups[w.group] : w.symbol);

const patch = (widgets: Widget[], id: string, change: Partial<Widget>) =>
  widgets.map((w) => (w.id === id ? { ...w, ...change } : w));

/** Panel types that no longer exist. A saved layout that holds one loses just that panel (a panel type missing from the registry would crash the grid). */
export const REMOVED_WIDGET_TYPES = ["jodi", "insider", "options", "chart", "heatmap", "screener"];

function withoutRemoved<T extends { widgets: Widget[]; layout: LayoutItem[]; focusedId: string | null }>(s: T): T {
  const gone = new Set(s.widgets.filter((w) => REMOVED_WIDGET_TYPES.includes(w.type)).map((w) => w.id));
  if (gone.size === 0) return s;
  const widgets = s.widgets.filter((w) => !gone.has(w.id));
  return { ...s, widgets, layout: s.layout.filter((l) => !gone.has(l.i)), focusedId: s.focusedId && gone.has(s.focusedId) ? (widgets[0]?.id ?? null) : s.focusedId };
}

/**
 * Persisted layouts: version 2 is kept (minus removed panels, in the live layout and in every saved workspace); anything older is the equity mock
 * layout and resets to the defaults.
 */
export function migrateWorkspace(persisted: any, version: number): any {
  if (version !== 2 || !persisted || !Array.isArray(persisted.widgets) || !Array.isArray(persisted.layout)) return defaults();
  const saved = Object.fromEntries(Object.entries(persisted.saved ?? {}).map(([name, snap]) => [name, withoutRemoved(snap as any)]));
  return { ...withoutRemoved(persisted), saved };
}

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
          const id = `${type}-${Date.now().toString(36)}${(idSeq++).toString(36)}`; // the counter keeps two panels added in the same millisecond apart
          const tf = useSettings.getState().defaultTf;
          // explicit symbol → pinned to it; otherwise join the focused widget's group, except that a group shares ONE symbol, so a second
          // panel of the same type (a second chart) would follow the first: it starts pinned to the same symbol instead and can be pointed elsewhere
          const group: Group = focused?.group ?? "amber";
          const sameTypeInGroup = s.widgets.some((w) => w.group === group && w.type === type);
          const widget: Widget = symbol
            ? { id, type, group: null, symbol, tf }
            : {
                id,
                type,
                group: sameTypeInGroup ? null : group,
                symbol: focused ? symbolOf(focused, s.groups) : s.groups.amber,
                tf,
              };
          const bottom = s.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
          return {
            widgets: [...s.widgets, widget],
            layout: [...s.layout, { i: id, x: 0, y: bottom, ...SIZE[type], w: Math.min(SIZE[type].w, GRID_COLS) }],
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

      setChannel: (id, channel) => set((s) => ({ widgets: patch(s.widgets, id, { channel }) })),
      setUrl: (id, url) => set((s) => ({ widgets: patch(s.widgets, id, { url }) })),
      focus: (focusedId) => set({ focusedId }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      reset: () => set({ ...defaults(), activeWorkspace: null }),
    }),
    {
      name: "drishti-workspace",
      version: 3,
      migrate: migrateWorkspace,
      partialize: ({ widgets, layout, groups, focusedId, saved, activeWorkspace }) => ({ widgets, layout, groups, focusedId, saved, activeWorkspace }),
    },
  ),
);

export function useWidgetSymbol(w: Widget) {
  return useWorkspace((s) => symbolOf(w, s.groups));
}
