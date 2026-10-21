import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { INSTRUMENTS, instrument, setCustomInstruments, SYMBOLS } from "@drishti/shared";
import { InstrumentsSettings } from "./InstrumentsSettings";
import { useStore } from "./store";

let calls: { url: string; method: string; body?: any }[];
let server: unknown[];
let reply: { status: number; json: unknown };

beforeEach(() => {
  calls = [];
  server = [];
  reply = { status: 201, json: {} };
  globalThis.confirm = () => true;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET") return { ok: true, status: 200, json: async () => ({ instruments: [...INSTRUMENTS.filter((i) => !i.custom), ...server] }) };
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.json };
  }) as never;
});
afterEach(() => {
  cleanup();
  setCustomInstruments([]);
});

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

test("lists the six built-ins as fixed, with no remove button", () => {
  render(<InstrumentsSettings />);
  expect(screen.getAllByText(/built in/)).toHaveLength(6);
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
});

test("the add button stays off, with the reason shown, until the form is valid", () => {
  render(<InstrumentsSettings />);
  const add = screen.getByRole("button", { name: "Add instrument" }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  fill("Symbol", "zinc");
  fill("Name", "Zinc");
  fill("Lot", "5000");
  expect(screen.getByRole("alert").textContent).toMatch(/lot must be units then a unit/);
  expect(add.disabled).toBe(true);
  fill("Lot", "5000 kg");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Will track MCX:ZINC")).toBeTruthy();
  expect(add.disabled).toBe(false);
});

test("submitting posts the form, then the catalogue and the app pick it up", async () => {
  const rev = useStore.getState().instrumentsRev;
  render(<InstrumentsSettings />);
  fill("Symbol", "zinc");
  fill("Name", "Zinc");
  fill("Lot", "5000 kg");
  fill("Price decimals", "2");
  server = [{ ...parse("MCX", "ZINC"), custom: true }];
  fireEvent.click(screen.getByRole("button", { name: "Add instrument" }));
  await waitFor(() => expect(instrument("MCX:ZINC")?.name).toBe("Zinc"));
  const post = calls.find((c) => c.method === "POST")!;
  expect(post.url).toContain("/instruments");
  expect(post.body).toMatchObject({ exchange: "MCX", root: "ZINC", name: "Zinc", lot: "5000 kg", topic: "crude" });
  expect(SYMBOLS).toContain("MCX:ZINC");
  expect(useStore.getState().instrumentsRev).toBe(rev + 1);
});

test("a server refusal is shown and nothing is added", async () => {
  reply = { status: 400, json: { error: "Upstox lists no ZINC future" } };
  render(<InstrumentsSettings />);
  fill("Symbol", "zinc");
  fill("Name", "Zinc");
  fill("Lot", "5000 kg");
  fireEvent.click(screen.getByRole("button", { name: "Add instrument" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/Upstox lists no ZINC/);
  expect(instrument("MCX:ZINC")).toBeUndefined();
});

test("an added instrument has a Remove button that deletes it on the server and drops it here", async () => {
  server = [{ ...parse("MCX", "ZINC"), custom: true }];
  setCustomInstruments(server as never);
  reply = { status: 200, json: { removed: "MCX:ZINC" } };
  render(<InstrumentsSettings />);
  expect(screen.getAllByText(/added by you/)).toHaveLength(1);
  server = [];
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(instrument("MCX:ZINC")).toBeUndefined());
  expect(calls.find((c) => c.method === "DELETE")!.url).toContain(encodeURIComponent("MCX:ZINC"));
});

test("choosing NYMEX swaps the Upstox field for a Yahoo one", () => {
  render(<InstrumentsSettings />);
  expect(screen.getByLabelText("Upstox underlying")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Exchange"), { target: { value: "NYMEX" } });
  expect(screen.queryByLabelText("Upstox underlying")).toBeNull();
  expect(screen.getByLabelText("Yahoo symbol")).toBeTruthy();
});

function parse(exchange: string, root: string) {
  return { symbol: `${exchange}:${root}`, name: "Zinc", exchange, currency: "INR", timeZone: "Asia/Kolkata", decimals: 2, topic: "crude", lot: "5000 kg", delayedBy: 0, sources: ["upstox", "tradingview"], upstox: root, tv: `${exchange}:${root}` };
}
