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
  useWorkspace.getState().loadWorkspace("preset:research");
  const s = useWorkspace.getState();
  expect(s.widgets.map((w) => w.type)).toEqual(["news", "calendar"]);
  expect(s.activeWorkspace).toBe("Research");
  useWorkspace.getState().loadWorkspace("preset:nope"); // unknown key: no change
  expect(useWorkspace.getState().activeWorkspace).toBe("Research");
});

test("saved workspaces round-trip, are copies, and can be deleted", () => {
  const ws = useWorkspace.getState();
  ws.loadWorkspace("preset:crude");
  expect(ws.saveWorkspace("  My   desk ")).toBe(true);
  expect(Object.keys(useWorkspace.getState().saved)).toEqual(["My desk"]);

  useWorkspace.getState().removeWidget("crude-chart-1"); // editing the live layout must not touch the stored one
  expect(useWorkspace.getState().saved["My desk"].widgets.some((w) => w.id === "crude-chart-1")).toBe(true);

  useWorkspace.getState().loadWorkspace("saved:My desk");
  expect(useWorkspace.getState().widgets.some((w) => w.id === "crude-chart-1")).toBe(true);
  expect(workspaceList(useWorkspace.getState().saved).map((w) => w.name).slice(-1)).toEqual(["My desk"]);

  useWorkspace.getState().deleteWorkspace("My desk");
  expect(useWorkspace.getState().saved).toEqual({});
  expect(useWorkspace.getState().activeWorkspace).toBeNull();
});

test("saving refuses empty names and built-in names", () => {
  expect(useWorkspace.getState().saveWorkspace("   ")).toBe(false);
  expect(useWorkspace.getState().saveWorkspace("research")).toBe(false);
});
