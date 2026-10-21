import { expect, test } from "bun:test";
import type { Alert } from "./alerts";
import type { AlertNotice } from "./notify";
import { parseAlertInput, ServerAlertEngine } from "./serverAlerts";

function setup(initial: Alert[]) {
  let rows = initial;
  const saved: Alert[] = [];
  const sent: AlertNotice[] = [];
  let events: any[] = [];
  let t = 1_000_000;
  const engine = new ServerAlertEngine({
    load: async () => rows.map((r) => ({ ...r })),
    save: async (a) => void saved.push(a),
    notify: async (n) => void sent.push(n),
    events: async () => events,
    now: () => t,
  });
  return { engine, saved, sent, setRows: (r: Alert[]) => (rows = r), setEvents: (e: any[]) => (events = e), tick: (ms: number) => (t += ms) };
}

const price = (over: Partial<Alert> = {}): Alert => ({ id: "p1", kind: "price", symbol: "MCX:CRUDEOIL", op: "above", value: 9500, armed: true, ...over });

test("a price alert fires once when the price crosses, is saved before it is sent, and then waits to be re-armed", async () => {
  const { engine, saved, sent } = setup([price()]);
  await engine.refresh();
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9490 } }); // first look: nothing to cross yet
  expect(sent).toHaveLength(0);
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9503 } });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ id: "p1", rule: "MCX:CRUDEOIL above 9500", message: "MCX:CRUDEOIL: 9503 (above 9500)" });
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ id: "p1", armed: false });
  expect(saved[0].firedAt).toBeDefined();
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9400 } });
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9600 } }); // crosses again, but it is no longer armed
  expect(sent).toHaveLength(1);
});

test("a reload from the database does not re-arm an alert that just fired", async () => {
  const { engine, sent, setRows } = setup([price()]);
  await engine.refresh();
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9490 } });
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9503 } });
  setRows([price()]); // the database still shows it armed (the save has not landed)
  await engine.refresh();
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9400 } });
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9510 } });
  expect(sent).toHaveLength(1);
});

test("a re-armed alert (database newer than the engine) fires again; a deleted one stops", async () => {
  const { engine, sent, setRows, tick } = setup([price()]);
  await engine.refresh();
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9490 } });
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9503 } });
  tick(1000);
  setRows([price({ armed: true, firedAt: 1_000_000, rearmedAt: 1_001_000 })]); // the user re-armed it after it fired
  await engine.refresh();
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9400 } });
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9505 } });
  expect(sent).toHaveLength(2);
  setRows([]);
  await engine.refresh();
  expect(engine.size).toBe(0);
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9400 } });
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9600 } });
  expect(sent).toHaveLength(2);
});

test("day-change alerts use the previous close", async () => {
  const { engine, sent } = setup([{ id: "c1", kind: "change", symbol: "NYMEX:CL", op: "above", value: 2, armed: true }]);
  await engine.refresh();
  await engine.onQuotes({ "NYMEX:CL": { price: 100, prevClose: 99 } }); // +1.01%
  await engine.onQuotes({ "NYMEX:CL": { price: 101.5, prevClose: 99 } }); // +2.53%
  expect(sent).toHaveLength(1);
  expect(sent[0].message).toContain("2.53%");
});

test("news alerts fire on fresh headlines that match, and keep watching", async () => {
  const { engine, sent } = setup([{ id: "n1", kind: "news", text: "opec", armed: true }]);
  await engine.refresh();
  const item = (title: string) => ({ id: title, title, source: "Reuters", url: "u", publishedAt: 1, tags: [] }) as never;
  await engine.onNews([item("Brent steady")]);
  expect(sent).toHaveLength(0);
  await engine.onNews([item("OPEC+ weighs deeper cuts")]);
  await engine.onNews([item("OPEC meeting delayed")]);
  expect(sent.map((s) => s.message)).toEqual(["Reuters: OPEC+ weighs deeper cuts", "Reuters: OPEC meeting delayed"]);
});

test("release alerts fire once per event inside their lead time", async () => {
  const { engine, sent, setEvents, tick } = setup([{ id: "r1", kind: "release", text: "EIA crude", minutes: 15, armed: true }]);
  await engine.refresh();
  const at = 1_000_000 + 10 * 60_000;
  setEvents([{ id: "eia-oil-1", title: "EIA crude inventories", at, kind: "energy", impact: "high" }]);
  await engine.tick();
  expect(sent[0]?.message).toBe("EIA crude inventories in 10 min");
  tick(60_000);
  await engine.tick();
  expect(sent).toHaveLength(1); // the same event is not announced twice
});

test("parseAlertInput accepts good rules and refuses bad ones with a reason", () => {
  expect(parseAlertInput({ kind: "price", symbol: "MCX:CRUDEOIL", op: "above", value: "9500" })).toEqual({ alert: { kind: "price", symbol: "MCX:CRUDEOIL", op: "above", value: 9500 } });
  expect(parseAlertInput({ kind: "change", symbol: "NYMEX:CL", op: "below", value: -3 })).toEqual({ alert: { kind: "change", symbol: "NYMEX:CL", op: "below", value: -3 } });
  expect(parseAlertInput({ kind: "news", text: "  OPEC " })).toEqual({ alert: { kind: "news", text: "OPEC" } });
  expect(parseAlertInput({ kind: "release", text: "EIA", minutes: 30 })).toEqual({ alert: { kind: "release", text: "EIA", minutes: 30 } });
  for (const bad of [null, {}, { kind: "price", symbol: "DOGE", op: "above", value: 1 }, { kind: "price", symbol: "MCX:CRUDEOIL", op: "up", value: 1 }, { kind: "price", symbol: "MCX:CRUDEOIL", op: "above", value: -5 }, { kind: "price", symbol: "MCX:CRUDEOIL", op: "above", value: "abc" }, { kind: "change", symbol: "NYMEX:CL", op: "above", value: 500 }, { kind: "news", text: "x" }, { kind: "news", text: "y".repeat(101) }, { kind: "release", text: "EIA", minutes: 0 }, { kind: "release", text: "EIA", minutes: 2.5 }]) {
    expect("error" in parseAlertInput(bad)).toBe(true);
  }
});

test("a burst of quotes during a slow save fires an alert once", async () => {
  const sent: string[] = [];
  const engine = new ServerAlertEngine({
    load: async () => [price(), price({ id: "p2", value: 9600 })],
    save: async () => void (await new Promise((r) => setTimeout(r, 20))), // a slow database
    notify: async (n) => void sent.push(n.id),
    events: async () => [],
    now: () => 1,
  });
  await engine.refresh();
  await engine.onQuotes({ "MCX:CRUDEOIL": { price: 9490 } });
  // three updates arrive together: up through both levels, higher still, then back down. Without serialising, the first run (holding a
  // stale copy of p2 as armed) resumes after the third and sees a fresh upward cross from 9500 to 9650: a second p2 message.
  await Promise.all([9650, 9700, 9500].map((p) => engine.onQuotes({ "MCX:CRUDEOIL": { price: p } })));
  expect(sent.sort()).toEqual(["p1", "p2"]); // each alert exactly once
});
