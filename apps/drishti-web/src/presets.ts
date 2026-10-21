import type { LayoutItem } from "react-grid-layout";
import type { Timeframe } from "@drishti/shared";
import type { Group, Widget, WidgetType } from "./workspace";

/** Everything a workspace is: which panels, where they sit, what each link group shows. */
export interface Snapshot {
  widgets: Widget[];
  layout: LayoutItem[];
  groups: Record<Group, string>;
  focusedId: string | null;
}

/** [id, type, link group (null = pinned to `symbol`), symbol, timeframe, x, y, w, h] on the 12-column grid. */
type Spec = [string, WidgetType, Group | null, string, Timeframe, number, number, number, number];

const GROUPS = { amber: "MCX:CRUDEOIL", blue: "NYMEX:CL", green: "MCX:NATURALGAS", red: "NYMEX:NG" } as const;

function snapshot(specs: Spec[], groups: Partial<Record<Group, string>> = {}): Snapshot {
  return {
    widgets: specs.map(([id, type, group, symbol, tf]) => ({ id, type, group, symbol, tf })),
    layout: specs.map(([i, , , , , x, y, w, h]) => ({ i, x, y, w, h })),
    groups: { ...GROUPS, ...groups },
    focusedId: specs[0][0],
  };
}

export interface Preset {
  key: string;
  name: string;
  hint: string;
  build: () => Snapshot;
}

/** Ready-made desks, F1…F5. Saved workspaces follow them (F6…F9). */
export const PRESETS: Preset[] = [
  {
    key: "crude",
    name: "MCX crude",
    hint: "Chart, quote and watchlist on top; news and calendar below",
    build: () =>
      snapshot([
        ["chart-1", "advchart", "amber", "MCX:CRUDEOIL", "5m", 0, 0, 8, 16],
        ["quote-1", "quote", "amber", "MCX:CRUDEOIL", "5m", 8, 0, 4, 9],
        ["watch-1", "watchlist", "amber", "MCX:CRUDEOIL", "5m", 8, 9, 4, 7],
        ["news-1", "news", "amber", "MCX:CRUDEOIL", "5m", 0, 16, 6, 10],
        ["cal-1", "calendar", null, "MCX:CRUDEOIL", "5m", 6, 16, 6, 10],
      ]),
  },
  {
    key: "gas",
    name: "Natural gas",
    hint: "MCX and Henry Hub charts side by side, with gas news and the EIA storage report",
    build: () =>
      snapshot([
        ["chart-1", "advchart", "green", "MCX:NATURALGAS", "5m", 0, 0, 6, 12],
        ["chart-2", "advchart", "red", "NYMEX:NG", "5m", 6, 0, 6, 12],
        ["quote-1", "quote", "green", "MCX:NATURALGAS", "5m", 0, 12, 4, 10],
        ["news-1", "news", "green", "MCX:NATURALGAS", "5m", 4, 12, 4, 10],
        ["cal-1", "calendar", null, "MCX:NATURALGAS", "5m", 8, 12, 4, 10],
      ]),
  },
  {
    key: "options",
    name: "Options",
    hint: "Options chain beside its underlying chart and quote",
    build: () =>
      snapshot([
        ["chart-1", "advchart", "amber", "MCX:CRUDEOIL", "5m", 0, 0, 5, 12],
        ["options-1", "options", "amber", "MCX:CRUDEOIL", "5m", 5, 0, 7, 14],
        ["quote-1", "quote", "amber", "MCX:CRUDEOIL", "5m", 0, 12, 5, 10],
      ]),
  },
  {
    key: "research",
    name: "Research",
    hint: "Energy heatmap and screener, news and the calendar",
    build: () =>
      snapshot([
        ["heat-1", "heatmap", null, "MCX:CRUDEOIL", "5m", 0, 0, 6, 12],
        ["screen-1", "screener", null, "MCX:CRUDEOIL", "5m", 6, 0, 6, 12],
        ["news-1", "news", null, "MCX:CRUDEOIL", "5m", 0, 12, 6, 10],
        ["cal-1", "calendar", null, "MCX:CRUDEOIL", "5m", 6, 12, 6, 10],
      ]),
  },
  {
    key: "watch",
    name: "Live watch",
    hint: "Live TV and news over a crude chart",
    build: () =>
      snapshot([
        ["tv-1", "tv", null, "MCX:CRUDEOIL", "5m", 0, 0, 6, 10],
        ["news-1", "news", "amber", "MCX:CRUDEOIL", "5m", 6, 0, 6, 10],
        ["chart-1", "advchart", "amber", "MCX:CRUDEOIL", "5m", 0, 10, 12, 10],
      ]),
  },
];

export const MAX_SAVED = 20;
export const cleanName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, 40);

/** Presets then saved workspaces, in F-key order (F1 = first). `key` feeds loadWorkspace. */
export const workspaceList = (saved: Record<string, unknown>) => [
  ...PRESETS.map((p) => ({ key: `preset:${p.key}`, name: p.name, hint: p.hint, saved: false })),
  ...Object.keys(saved).map((name) => ({ key: `saved:${name}`, name, hint: "Your saved workspace", saved: true })),
];
