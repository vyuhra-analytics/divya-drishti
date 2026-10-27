import { expect, test } from "bun:test";
import { queueOption, useStore } from "./store";

const q = (key: string, price: number) => ({ key, price, time: 0, recvAt: 0 }) as never;
/** let a flush another test file may have left in flight finish, so these tests start from a quiet store */
const drain = () => new Promise((r) => setTimeout(r, 400));

test("option quotes are applied together: a burst appears in ONE state change, with the newest quote of each contract", async () => {
  await drain();
  useStore.setState({ options: {} });
  const seen: Record<string, number>[] = [];
  const off = useStore.subscribe((s) => void seen.push(Object.fromEntries(Object.entries(s.options).map(([k, v]) => [k, v.price]))));
  queueOption(q("MCX_FO|881", 100));
  queueOption(q("MCX_FO|882", 50));
  queueOption(q("MCX_FO|881", 101)); // the same contract again before the flush
  expect(useStore.getState().options["MCX_FO|881"]).toBeUndefined(); // nothing yet
  await new Promise((r) => setTimeout(r, 400));
  off();
  const first = seen.find((o) => "MCX_FO|881" in o || "MCX_FO|882" in o)!;
  expect(first["MCX_FO|881"]).toBe(101); // the newest of the two
  expect(first["MCX_FO|882"]).toBe(50); // in the same change as the other contract (other test files may add keys of their own)
});

test("a later burst keeps what an earlier one set", async () => {
  await drain();
  useStore.setState({ options: {} });
  queueOption(q("MCX_FO|1", 100));
  await new Promise((r) => setTimeout(r, 400));
  queueOption(q("MCX_FO|2", 7));
  await new Promise((r) => setTimeout(r, 400));
  const o = useStore.getState().options;
  expect([o["MCX_FO|1"]?.price, o["MCX_FO|2"]?.price]).toEqual([100, 7]); // both are there (other test files may add keys of their own)
});
