import { afterEach, expect, test } from "bun:test";
import { ensureChartDefaults } from "./advDefaults";

// A chart gets a Volume pane and the bar-close countdown once; an index (no volume) gets only the countdown.
const chart = () => {
  const added: string[] = [];
  const axis: object[] = [];
  return { added, axis, widget: { chart: { indicators: () => [], addIndicator: (id: string) => void added.push(id), setAxisChromeOptions: (o: object) => void axis.push(o) } } };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => localStorage.clear());

test("a futures chart gets the Volume pane and the countdown; an index chart gets the countdown only", async () => {
  const futures = chart();
  ensureChartDefaults(futures.widget, "w-futures");
  const index = chart();
  ensureChartDefaults(index.widget, "w-index", { volume: false });
  await wait(2900); // the defaults wait a few 800 ms tries for saved studies to load
  expect(futures.added).toEqual(["volume"]);
  expect(futures.axis).toEqual([{ barCountdown: true }]);
  expect(index.added).toEqual([]); // an index has no volume: an empty pane would only take room
  expect(index.axis).toEqual([{ barCountdown: true }]);
}, 10_000);
