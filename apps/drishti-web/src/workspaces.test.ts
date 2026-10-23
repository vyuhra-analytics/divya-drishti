import { beforeEach, expect, test } from "bun:test";
import { PRESETS, workspaceList } from "./presets";
import { useWorkspace } from "./workspace";

beforeEach(() => useWorkspace.setState({ saved: {}, activeWorkspace: null }));

test("every preset is a valid grid: unique ids, one layout item per widget, inside 12 columns, no overlap", () => {
  for (const p of PRESETS) {
    const { widgets, layout, focusedId } = p.build();
    const ids = widgets.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(layout.map((l) => l.i).sort()).toEqual([...ids].sort());
    expect(ids).toContain(focusedId!);
    for (const l of layout) expect(l.x + l.w).toBeLessThanOrEqual(12);
    for (const a of layout)
      for (const b of layout)
        if (a !== b) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
  }
});

test("loading a preset replaces the layout and marks it active", () => {
  useWorkspace.getState().loadWorkspace("preset:presession");
  const s = useWorkspace.getState();
  expect(s.widgets.map((w) => w.type)).toEqual(["recap", "calendar", "curve", "advchart", "news"]);
  expect(s.activeWorkspace).toBe("Pre-session");
  useWorkspace.getState().loadWorkspace("preset:nope"); // unknown key: no change
  expect(useWorkspace.getState().activeWorkspace).toBe("Pre-session");
});

test("saved workspaces round-trip, are copies, and can be deleted", () => {
  const ws = useWorkspace.getState();
  ws.loadWorkspace("preset:evening");
  expect(ws.saveWorkspace("  My   desk ")).toBe(true);
  expect(Object.keys(useWorkspace.getState().saved)).toEqual(["My desk"]);

  useWorkspace.getState().removeWidget("evening-chart-1"); // editing the live layout must not touch the stored one
  expect(useWorkspace.getState().saved["My desk"].widgets.some((w) => w.id === "evening-chart-1")).toBe(true);

  useWorkspace.getState().loadWorkspace("saved:My desk");
  expect(useWorkspace.getState().widgets.some((w) => w.id === "evening-chart-1")).toBe(true);
  expect(workspaceList(useWorkspace.getState().saved).map((w) => w.name).slice(-1)).toEqual(["My desk"]);

  useWorkspace.getState().deleteWorkspace("My desk");
  expect(useWorkspace.getState().saved).toEqual({});
  expect(useWorkspace.getState().activeWorkspace).toBeNull();
});

test("saving refuses empty names and built-in names", () => {
  expect(useWorkspace.getState().saveWorkspace("   ")).toBe(false);
  expect(useWorkspace.getState().saveWorkspace("evening")).toBe(false);
  expect(useWorkspace.getState().saveWorkspace("Macro and TV")).toBe(false);
});

// ---- several charts, each on its own symbol
const fresh = () =>
  useWorkspace.setState({
    widgets: [
      { id: "chart-1", type: "advchart", group: "amber", symbol: "MCX:CRUDEOIL", tf: "5m" },
      { id: "quote-1", type: "quote", group: "amber", symbol: "MCX:CRUDEOIL", tf: "5m" },
    ],
    layout: [
      { i: "chart-1", x: 0, y: 0, w: 6, h: 10 },
      { i: "quote-1", x: 6, y: 0, w: 3, h: 10 },
    ],
    groups: { amber: "MCX:CRUDEOIL", blue: "NYMEX:CL", green: "MCX:NATURALGAS", red: "NYMEX:NG" },
    focusedId: "chart-1",
  });

test("a second chart added next to a linked chart starts pinned, so it can show a different symbol", () => {
  fresh();
  useWorkspace.getState().addWidget("advchart");
  const added = useWorkspace.getState().widgets.at(-1)!;
  expect(added.group).toBeNull(); // not in the amber group, which already has a chart
  expect(added.symbol).toBe("MCX:CRUDEOIL"); // it starts on the same symbol
  // pointing the new chart elsewhere changes only that chart
  useWorkspace.getState().loadSymbol(added.id, "NYMEX:CL");
  const s = useWorkspace.getState();
  expect(s.widgets.find((w) => w.id === added.id)!.symbol).toBe("NYMEX:CL");
  expect(s.groups.amber).toBe("MCX:CRUDEOIL");
  expect(s.widgets.find((w) => w.id === "chart-1")!.group).toBe("amber");
  // a third chart, with the new pinned one focused, is pinned too and independent of both
  useWorkspace.getState().addWidget("advchart");
  const third = useWorkspace.getState().widgets.at(-1)!;
  expect(third.group).toBeNull();
  expect(third.symbol).toBe("NYMEX:CL");
  useWorkspace.getState().loadSymbol(third.id, "MCX:NATURALGAS");
  expect(useWorkspace.getState().widgets.find((w) => w.id === added.id)!.symbol).toBe("NYMEX:CL");
});

test("a panel of a different type still joins the focused group, so a chart and its quote stay linked", () => {
  fresh();
  useWorkspace.getState().addWidget("watchlist");
  expect(useWorkspace.getState().widgets.at(-1)!.group).toBe("amber");
  useWorkspace.getState().loadSymbol("chart-1", "NYMEX:NG");
  expect(useWorkspace.getState().groups.amber).toBe("NYMEX:NG"); // the linked panels follow
});

test("an explicit symbol (the palette's CL GP) opens a pinned chart on that symbol and leaves the others alone", () => {
  fresh();
  useWorkspace.getState().addWidget("advchart", "NYMEX:CL");
  const added = useWorkspace.getState().widgets.at(-1)!;
  expect(added).toMatchObject({ group: null, symbol: "NYMEX:CL" });
  expect(useWorkspace.getState().groups.amber).toBe("MCX:CRUDEOIL");
});

test("with the focused chart pinned, a new chart joins a group that has no chart yet and never moves the pinned one", () => {
  fresh();
  while (useWorkspace.getState().widgets.find((w) => w.id === "chart-1")!.group !== null) useWorkspace.getState().cycleGroup("chart-1");
  const pinned = useWorkspace.getState().widgets.find((w) => w.id === "chart-1")!;
  useWorkspace.getState().addWidget("advchart");
  const added = useWorkspace.getState().widgets.at(-1)!;
  expect(added.group).toBe("amber"); // amber has only the quote: no second chart in it, so it links
  useWorkspace.getState().loadSymbol(added.id, "MCX:NATURALGAS");
  expect(useWorkspace.getState().groups.amber).toBe("MCX:NATURALGAS");
  expect(useWorkspace.getState().widgets.find((w) => w.id === "chart-1")!.symbol).toBe(pinned.symbol); // the pinned chart did not move
});

test("panels added in the same millisecond get different ids, so changing one never changes another", () => {
  fresh();
  const realNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    useWorkspace.getState().addWidget("advchart");
    useWorkspace.getState().addWidget("advchart");
  } finally {
    Date.now = realNow;
  }
  const ids = useWorkspace.getState().widgets.map((w) => w.id);
  expect(new Set(ids).size).toBe(ids.length);
});

// ---- the redesigned desks (docs/redesign/RESEARCH_DESK.md): six built-in desks, F1 to F6
const types = (key: string) => PRESETS.find((p) => p.key === key)!.build().widgets.map((w) => w.type);

test("the built-in desks are the Evening desk and the five research workspaces, in F-key order", () => {
  expect(PRESETS.map((p) => p.key)).toEqual(["evening", "presession", "reportprep", "review", "study", "macro"]);
  expect(PRESETS.map((p) => p.name)).toEqual(["Evening", "Pre-session", "Report prep", "Review", "Study", "Macro and TV"]);
  // six built-in desks leave F7 to F9 for three saved ones
  expect(workspaceList({ a: 1 }).map((w) => w.saved)).toEqual([false, false, false, false, false, false, true]);
});

test("each desk holds what its question needs", () => {
  expect(types("evening")).toEqual(expect.arrayContaining(["advchart", "quote", "calendar", "optionchain"]));
  expect(types("presession")).toEqual(expect.arrayContaining(["recap", "calendar", "curve", "advchart", "news"]));
  expect(types("reportprep")).toEqual(expect.arrayContaining(["eiareport", "calendar", "optionchain", "advchart", "cot"]));
  expect(types("review")).toEqual(expect.arrayContaining(["paper", "advchart", "costs", "quality"]));
  expect(types("study")).toEqual(expect.arrayContaining(["backtest", "advchart", "costs", "cot"]));
  expect(types("macro")).toEqual(expect.arrayContaining(["chokepoints", "curve", "tv", "news"]));
});

test("the first screen of every desk fits one monitor: 28 grid rows (34 px each in the default compact density, a 1080p monitor), the Report prep desk scrolling only for its last row", () => {
  for (const p of PRESETS) {
    const { layout } = p.build();
    const first = layout.filter((l) => l.y < 28);
    const reach = Math.max(...first.map((l) => l.y + l.h));
    expect([p.key, reach <= 28]).toEqual([p.key, true]);
    // nothing important hides below the fold except the deliberate last row of Report prep
    const below = layout.filter((l) => l.y >= 28);
    expect([p.key, below.length === 0 || p.key === "reportprep"]).toEqual([p.key, true]);
  }
});

test("the evening desk is the first run, the reset and the fallback for a damaged saved layout", () => {
  useWorkspace.getState().reset();
  const s = useWorkspace.getState();
  expect(s.widgets.map((w) => w.type)).toEqual(types("evening"));
  expect(s.widgets[0].id).toBe("evening-chart-1");
  expect(s.focusedId).toBe("evening-chart-1"); // the chart is focused: a symbol typed in the palette goes to it
  expect(s.widgets.find((w) => w.type === "advchart")).toMatchObject({ group: "amber", symbol: "MCX:CRUDEOIL", tf: "5m" });
});
