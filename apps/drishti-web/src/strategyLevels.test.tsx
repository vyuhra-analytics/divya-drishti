import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { ensureStrategyLevels, STRATEGY_LEVELS_ID, strategyLevelsIndicator } from "./advStrategyLevels";
import { useLevels, usePublishLevels, type LevelInput } from "./strategyLevels";

const level = (price: number, title = "L"): LevelInput => ({ price, title, color: "#fff" });
function Publisher({ source, levels }: { source: string; levels: (LevelInput | undefined)[] }) {
  usePublishLevels(source, levels);
  return null;
}

beforeEach(() => act(() => void useLevels.setState({ sources: {} })));
afterEach(cleanup);

test("a panel publishes its levels under its own source, replaces them when they change, and clears them when it goes", () => {
  const { rerender, unmount } = render(<Publisher source="a" levels={[level(100, "high"), level(90, "low")]} />);
  expect(useLevels.getState().sources.a.map((l) => l.price)).toEqual([100, 90]);
  rerender(<Publisher source="a" levels={[level(101, "high")]} />);
  expect(useLevels.getState().sources.a.map((l) => l.price)).toEqual([101]);
  render(<Publisher source="b" levels={[level(50)]} />);
  expect(Object.keys(useLevels.getState().sources).sort()).toEqual(["a", "b"]);
  unmount();
  expect(useLevels.getState().sources.a).toBeUndefined();
  expect(useLevels.getState().sources.b).toBeDefined();
});

test("a level with no price (NaN, undefined) is left out, and no levels removes the source", () => {
  render(<Publisher source="a" levels={[level(NaN), undefined, level(5)]} />);
  expect(useLevels.getState().sources.a.map((l) => l.price)).toEqual([5]);
  cleanup();
  render(<Publisher source="a" levels={[level(NaN)]} />);
  expect(useLevels.getState().sources.a).toBeUndefined();
});

test("the study draws every published level as a price line and recomputes when a panel publishes", () => {
  const d = strategyLevelsIndicator();
  act(() => useLevels.getState().set("a", [{ price: 9650, title: "Range high", color: "#42a5f5", style: "solid" }, { price: 9600, title: "Stop 1R", color: "#ef5350" }]));
  const lines = d.levels!({} as never) as unknown as { price: number; title: string; lineStyle: string }[];
  expect(lines.map((l) => [l.price, l.title, l.lineStyle])).toEqual([[9650, "Range high", "solid"], [9600, "Stop 1R", "dashed"]]);
  const recompute = mock(() => undefined);
  const off = d.attach!({ requestRecompute: recompute } as never) as () => void;
  act(() => useLevels.getState().set("b", [level(1)]));
  expect(recompute).toHaveBeenCalledTimes(1);
  off();
  act(() => useLevels.getState().set("b", []));
  expect(recompute).toHaveBeenCalledTimes(1); // detached: no more calls
});

test("a desk chart gets the study added once, and not again when it is there", async () => {
  const added: string[] = [];
  const chart = { indicators: () => added.map((indicatorId) => ({ indicatorId })), addIndicator: (id: string) => void added.push(id) };
  ensureStrategyLevels({ chart });
  await new Promise((r) => setTimeout(r, 1000));
  expect(added).toEqual([STRATEGY_LEVELS_ID]);
  ensureStrategyLevels({ chart });
  await new Promise((r) => setTimeout(r, 1000));
  expect(added).toEqual([STRATEGY_LEVELS_ID]);
});
