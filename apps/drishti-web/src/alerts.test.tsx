import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { startAlertEngine } from "./alertEngine";
import { AlertsWidget, Toasts } from "./AlertsPanel";
import { useAlerts } from "./alertsStore";
import { useSettings } from "./settings";
import { useStore } from "./store";
import type { Widget } from "./workspace";

const widget = { id: "al", type: "alerts", group: null, symbol: "MCX:CRUDEOIL", tf: "1m" } as Widget;
const quote = (price: number) => ({ "MCX:CRUDEOIL": { symbol: "MCX:CRUDEOIL", price, prevClose: 9000, time: Date.now(), delayedBy: 0, source: "upstox" } as never });
let stop = () => {};

beforeEach(() => {
  useAlerts.setState({ alerts: [], history: [], toasts: [] });
  useStore.setState({ quotes: {}, news: [] });
  useSettings.setState({ alertSound: false });
  stop = startAlertEngine();
});
afterEach(() => {
  stop();
  cleanup();
});

test("a price alert fires once when the price crosses, shows a toast and a history row", () => {
  useAlerts.getState().add({ kind: "price", symbol: "MCX:CRUDEOIL", op: "above", value: 9500 });
  act(() => useStore.setState({ quotes: quote(9400) }));
  expect(useAlerts.getState().toasts).toHaveLength(0);
  act(() => useStore.setState({ quotes: quote(9510) }));
  expect(useAlerts.getState().toasts).toHaveLength(1);
  expect(useAlerts.getState().history[0].message).toContain("9510");
  expect(useAlerts.getState().alerts[0].armed).toBe(false);
  act(() => useStore.setState({ quotes: quote(9600) }));
  expect(useAlerts.getState().toasts).toHaveLength(1); // spent

  useAlerts.getState().rearm(useAlerts.getState().alerts[0].id);
  expect(useAlerts.getState().alerts[0].armed).toBe(true);
});

test("a news alert fires for a new matching headline only", () => {
  useAlerts.getState().add({ kind: "news", text: "opec" });
  const item = (id: string, title: string) => ({ id, title, url: "u", source: "Reuters", publishedAt: Date.now(), tags: [] as never });
  act(() => useStore.setState({ news: [{ ...item("old", "OPEC old story"), publishedAt: Date.now() - 3 * 3600_000 }] })); // backlog on connect
  expect(useAlerts.getState().toasts).toHaveLength(0);
  act(() => useStore.setState({ news: [item("a", "OPEC meets")] }));
  const first = useAlerts.getState().toasts.length;
  expect(first).toBe(1);
  act(() => useStore.setState({ news: [item("a", "OPEC meets"), item("b", "Gold up")] }));
  expect(useAlerts.getState().toasts.length).toBe(first);
  act(() => useStore.setState({ news: [item("a", "OPEC meets"), item("b", "Gold up"), item("c", "OPEC+ extends cut")] }));
  expect(useAlerts.getState().toasts.length).toBe(first + 1);
});

test("the alerts panel adds and deletes alerts, and toasts can be dismissed", () => {
  render(
    <>
      <AlertsWidget widget={widget} />
      <Toasts />
    </>,
  );
  const add = screen.getByText("Add alert") as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Price level"), { target: { value: "9500" } });
  fireEvent.click(add);
  expect(screen.getByText("MCX:CRUDEOIL above 9500")).toBeTruthy();

  act(() => useAlerts.getState().push("x", "Test fired"));
  fireEvent.click(screen.getByTitle("Dismiss"));
  expect(useAlerts.getState().toasts).toHaveLength(0);

  fireEvent.click(screen.getByLabelText("Delete alert MCX:CRUDEOIL above 9500"));
  expect(screen.getByText(/No alerts yet/)).toBeTruthy();
});
