import { expect, test } from "bun:test";
import { migrateWorkspace, REMOVED_WIDGET_TYPES } from "./workspace";

const widget = (id: string, type: string) => ({ id, type, group: "amber", symbol: "MCX:CRUDEOIL", tf: "5m" });
const state = () => ({
  widgets: [widget("chart-1", "advchart"), widget("jodi-1", "jodi"), widget("quote-1", "quote")],
  layout: [
    { i: "chart-1", x: 0, y: 0, w: 8, h: 12 },
    { i: "jodi-1", x: 8, y: 0, w: 4, h: 8 },
    { i: "quote-1", x: 8, y: 8, w: 4, h: 9 },
  ],
  groups: { amber: "MCX:CRUDEOIL", blue: "NYMEX:CL", green: "MCX:NATURALGAS", red: "NYMEX:NG" },
  focusedId: "chart-1",
  saved: {} as Record<string, any>,
  activeWorkspace: null,
});

test("JODI is one of the removed panel types", () => {
  expect(REMOVED_WIDGET_TYPES).toContain("jodi");
  expect(REMOVED_WIDGET_TYPES).toContain("insider");
  expect(REMOVED_WIDGET_TYPES).toContain("options");
  expect(REMOVED_WIDGET_TYPES).toContain("chart");
  expect(REMOVED_WIDGET_TYPES).toContain("heatmap");
  expect(REMOVED_WIDGET_TYPES).toContain("screener");
});

test("a saved layout that held a removed panel loses only that panel, not the whole layout", () => {
  const out = migrateWorkspace(state(), 2);
  expect(out.widgets.map((w: any) => w.id)).toEqual(["chart-1", "quote-1"]);
  expect(out.layout.map((l: any) => l.i)).toEqual(["chart-1", "quote-1"]);
  expect(out.layout[1]).toMatchObject({ x: 8, y: 8, w: 4, h: 9 }); // the others keep their places
  expect(out.focusedId).toBe("chart-1");
});

test("focus moves to a surviving panel when the focused one was removed", () => {
  const s = state();
  s.focusedId = "jodi-1";
  expect(migrateWorkspace(s, 2).focusedId).toBe("chart-1");
  const only = { ...state(), widgets: [widget("jodi-1", "jodi")], layout: [{ i: "jodi-1", x: 0, y: 0, w: 4, h: 8 }], focusedId: "jodi-1" };
  expect(migrateWorkspace(only, 2).focusedId).toBeNull();
});

test("workspaces the user saved are cleaned too, and a layout without removed panels comes back untouched", () => {
  const s = state();
  s.saved = { "My desk": { widgets: s.widgets, layout: s.layout, groups: s.groups, focusedId: "quote-1" } };
  const out = migrateWorkspace(s, 2);
  expect(out.saved["My desk"].widgets.map((w: any) => w.type)).toEqual(["advchart", "quote"]);
  expect(out.saved["My desk"].layout).toHaveLength(2);
  const clean = { ...state(), widgets: [widget("chart-1", "advchart")], layout: [{ i: "chart-1", x: 0, y: 0, w: 8, h: 12 }] };
  const same = migrateWorkspace(clean, 2);
  expect(same.widgets).toEqual(clean.widgets);
});

test("an older or damaged saved state resets to the defaults instead of crashing", () => {
  expect(migrateWorkspace(state(), 1).widgets.length).toBeGreaterThan(0); // the equity mock layout is gone
  expect(migrateWorkspace(null, 2).widgets.length).toBeGreaterThan(0);
  expect(migrateWorkspace({ widgets: "nope", layout: [] }, 2).widgets.length).toBeGreaterThan(0);
});
