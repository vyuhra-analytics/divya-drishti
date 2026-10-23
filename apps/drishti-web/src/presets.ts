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

/** Widget ids are prefixed with the desk key: panels keep saved state (drawings, indicators) under their id, and two desks must not share it. */
function snapshot(desk: string, specs: Spec[], groups: Partial<Record<Group, string>> = {}): Snapshot {
  const id = (raw: string) => `${desk}-${raw}`;
  return {
    widgets: specs.map(([raw, type, group, symbol, tf]) => ({ id: id(raw), type, group, symbol, tf })),
    layout: specs.map(([raw, , , , , x, y, w, h]) => ({ i: id(raw), x, y, w, h })),
    groups: { ...GROUPS, ...groups },
    focusedId: id(specs[0][0]),
  };
}

export interface Preset {
  key: string;
  name: string;
  hint: string;
  build: () => Snapshot;
}

/**
 * Ready-made desks, F1…F6; saved workspaces follow them (F7…F9). Laid out for one large monitor: a grid row is 34 px in the default compact density (40 px
 * comfortable), so 28 rows fit a 1080p monitor without scrolling in compact, and every desk's first screen is built to that height (the Report prep desk scrolls for its last row).
 * `docs/redesign/RESEARCH_DESK.md` says what question each desk answers. The Evening desk here is an interim of today's panels for the
 * evening session; the purpose-built evening screen (`EIA_SCREENS.md`) replaces it when it is built.
 */
export const PRESETS: Preset[] = [
  {
    key: "evening",
    name: "Evening",
    hint: "The evening session: the future's 5-minute chart, quote, the next release, and the options chain under them",
    build: () =>
      snapshot("evening", [
        ["chart-1", "advchart", "amber", "MCX:CRUDEOIL", "5m", 0, 0, 8, 17],
        ["quote-1", "quote", "amber", "MCX:CRUDEOIL", "5m", 8, 0, 4, 8],
        ["cal-1", "calendar", null, "MCX:CRUDEOIL", "5m", 8, 8, 4, 9],
        ["optionchain-1", "optionchain", "amber", "MCX:CRUDEOIL", "5m", 0, 17, 12, 11],
      ]),
  },
  {
    key: "presession",
    name: "Pre-session",
    hint: "Before the evening: the plain-language recap, today's releases, the futures curve, the chart and the news",
    build: () =>
      snapshot("presession", [
        ["recap-1", "recap", "amber", "MCX:CRUDEOIL", "5m", 0, 0, 4, 11],
        ["cal-1", "calendar", null, "MCX:CRUDEOIL", "5m", 4, 0, 4, 11],
        ["curve-1", "curve", "amber", "MCX:CRUDEOIL", "5m", 8, 0, 4, 11],
        ["chart-1", "advchart", "amber", "MCX:CRUDEOIL", "5m", 0, 11, 8, 17],
        ["news-1", "news", "amber", "MCX:CRUDEOIL", "5m", 8, 11, 4, 17],
      ]),
  },
  {
    key: "reportprep",
    name: "Report prep",
    hint: "Tuesday to Thursday: the EIA numbers and the calendar over the options chain; the chart and positioning below",
    build: () =>
      snapshot("reportprep", [
        ["eiareport-1", "eiareport", null, "MCX:CRUDEOIL", "5m", 0, 0, 6, 11],
        ["cal-1", "calendar", null, "MCX:CRUDEOIL", "5m", 6, 0, 6, 11],
        ["optionchain-1", "optionchain", "amber", "MCX:CRUDEOIL", "5m", 0, 11, 12, 17],
        ["chart-1", "advchart", "amber", "MCX:CRUDEOIL", "5m", 0, 28, 6, 12],
        ["cot-1", "cot", "amber", "MCX:CRUDEOIL", "5m", 6, 28, 6, 12],
      ]),
  },
  {
    key: "review",
    name: "Review",
    hint: "After the session: the paper journal, the chart with replay, the costs and the data quality",
    build: () =>
      snapshot("review", [
        ["paper-1", "paper", null, "MCX:CRUDEOIL", "5m", 0, 0, 6, 14],
        ["chart-1", "advchart", "amber", "MCX:CRUDEOIL", "5m", 6, 0, 6, 14],
        ["costs-1", "costs", "amber", "MCX:CRUDEOIL", "5m", 0, 14, 6, 14],
        ["quality-1", "quality", null, "MCX:CRUDEOIL", "5m", 6, 14, 6, 14],
      ]),
  },
  {
    key: "study",
    name: "Study",
    hint: "Weekends: the strategy tester with the chart, the costs and the speculators' positioning",
    build: () =>
      snapshot("study", [
        ["backtest-1", "backtest", "amber", "MCX:CRUDEOIL", "5m", 0, 0, 8, 16],
        ["chart-1", "advchart", "amber", "MCX:CRUDEOIL", "5m", 8, 0, 4, 16],
        ["costs-1", "costs", "amber", "MCX:CRUDEOIL", "5m", 0, 16, 6, 12],
        ["cot-1", "cot", "amber", "MCX:CRUDEOIL", "5m", 6, 16, 6, 12],
      ]),
  },
  {
    key: "macro",
    name: "Macro and TV",
    hint: "The wider energy picture: shipping chokepoints, the futures curve, live TV and the news",
    build: () =>
      snapshot("macro", [
        ["choke-1", "chokepoints", null, "MCX:CRUDEOIL", "5m", 0, 0, 6, 14],
        ["curve-1", "curve", "amber", "MCX:CRUDEOIL", "5m", 6, 0, 6, 14],
        ["tv-1", "tv", null, "MCX:CRUDEOIL", "5m", 0, 14, 6, 14],
        ["news-1", "news", "amber", "MCX:CRUDEOIL", "5m", 6, 14, 6, 14],
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
