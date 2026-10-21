import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AlertsWidget } from "./AlertsPanel";
import { useAlerts } from "./alertsStore";
import type { Widget } from "./workspace";

const widget = { id: "al", type: "alerts", group: null } as Widget;
const calls: { url: string; method: string; body?: any }[] = [];
let server: { alerts: any[]; channels: any; fail?: string };

beforeEach(() => {
  calls.length = 0;
  useAlerts.setState({ alerts: [], history: [], toasts: [] });
  server = { alerts: [], channels: { telegram: true, telegramLinked: true, webhook: false } };
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/alerts/, "");
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (server.fail) return { ok: false, status: 503, json: async () => ({ message: server.fail }) };
    if (path === "" && (init?.method ?? "GET") === "GET") return { ok: true, status: 200, json: async () => server.alerts };
    if (path === "/channels") return { ok: true, status: 200, json: async () => server.channels };
    if (path === "" && init?.method === "POST") {
      const a = { ...JSON.parse(String(init.body)), id: "sa-1", armed: true };
      server.alerts = [a];
      return { ok: true, status: 200, json: async () => a };
    }
    if (path === "/test") return { ok: true, status: 200, json: async () => ({ results: [{ channel: "telegram", ok: true }] }) };
    if (path.startsWith("/sa-1") && init?.method === "DELETE") {
      server.alerts = [];
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as never;
});
afterEach(cleanup);

test("a server alert is created on the server, listed as such, and can be deleted", async () => {
  render(<AlertsWidget widget={widget} />);
  fireEvent.change(screen.getByLabelText("Price level"), { target: { value: "9500" } });
  fireEvent.click(screen.getByLabelText(/From the server/));
  fireEvent.click(screen.getByRole("button", { name: "Add alert" }));
  await screen.findByText(/· server/);
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/alerts"))!;
  expect(post.body).toEqual({ kind: "price", symbol: "MCX:CRUDEOIL", op: "above", value: 9500 });
  expect(useAlerts.getState().alerts).toHaveLength(0); // not also a local alert: no double firing
  fireEvent.click(screen.getByLabelText(/Delete server alert/));
  await waitFor(() => expect(screen.queryByText(/· server/)).toBeNull());
  expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/alerts/sa-1"))).toBe(true);
});

test("without the checkbox the alert stays local and nothing is sent to the server", async () => {
  render(<AlertsWidget widget={widget} />);
  fireEvent.change(screen.getByLabelText("Price level"), { target: { value: "9500" } });
  fireEvent.click(screen.getByRole("button", { name: "Add alert" }));
  await waitFor(() => expect(useAlerts.getState().alerts).toHaveLength(1));
  expect(calls.some((c) => c.method === "POST")).toBe(false);
});

test("shows which delivery channels are set up and sends a test message only when asked", async () => {
  render(<AlertsWidget widget={widget} />);
  await screen.findByText(/Telegram linked/);
  expect(calls.some((c) => c.url.endsWith("/test"))).toBe(false); // nothing is sent on its own
  fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
  await screen.findByText("telegram: sent");
  expect(calls.filter((c) => c.url.endsWith("/test"))).toHaveLength(1);
});

test("a bot with no chat linked offers Link Telegram; no token says not set up", async () => {
  server.channels = { telegram: true, telegramLinked: false, webhook: false };
  render(<AlertsWidget widget={widget} />);
  await screen.findByText(/bot set, chat not linked/);
  expect(screen.getByRole("button", { name: "Link Telegram" })).toBeTruthy();
  cleanup();
  server.channels = { telegram: false, telegramLinked: false, webhook: false };
  render(<AlertsWidget widget={widget} />);
  await screen.findByText(/Telegram not set up/);
  expect(screen.queryByRole("button", { name: "Send test message" })).toBeNull();
});

test("the database being down is said plainly and the form keeps its values", async () => {
  server.fail = "Server alerts need the database (bun run infra:up)";
  render(<AlertsWidget widget={widget} />);
  await screen.findByText(/Server alerts unavailable: Server alerts need the database/);
  fireEvent.change(screen.getByLabelText("Price level"), { target: { value: "9500" } });
  fireEvent.click(screen.getByLabelText(/From the server/));
  fireEvent.click(screen.getByRole("button", { name: "Add alert" }));
  await screen.findByText(/need the database/, { selector: "p" });
  expect((screen.getByLabelText("Price level") as HTMLInputElement).value).toBe("9500");
});
