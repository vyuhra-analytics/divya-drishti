import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Chain } from "@drishti/shared";
import { OptionChainWidget } from "./OptionChainPanel";
import type { Widget } from "./workspace";

const widget = { id: "ocx", type: "optionchain", group: null, symbol: "MCX:CRUDEOIL", tf: "5m" } as Widget;
const leg = (key: string, over: object = {}) => ({ key, ltp: 500, change: -10, bid: 499, ask: 501, oi: 2000, volume: 1500, iv: 50.12, delta: 0.5, theta: -9.2, vega: 10.1, gamma: 0.0003, ...over });
const chain = (over: Partial<Chain> = {}): Chain => ({
  underlying: "CRUDEOIL",
  expiry: "2026-11-17",
  expiries: ["2026-11-17", "2026-12-16", "2027-01-15"],
  spot: 9286,
  atm: 9300,
  pcr: 1.3,
  maxPain: 9300,
  updatedAt: 1,
  source: "combined",
  oiBasis: "previous-close",
  rows: [
    { strike: 9250, ce: leg("a", { oi: 6131, prevOi: 5288, oiChange: 843 }), pe: leg("b", { oi: 11212, prevOi: 11000, oiChange: 212 }) },
    { strike: 9300, ce: leg("c", { oi: 20951, prevOi: 21000, oiChange: -49 }), pe: leg("d", { oi: 33188, prevOi: 30000, oiChange: 3188 }) },
    { strike: 9350, ce: leg("e", { oi: 0 }), pe: leg("f", { oi: 11719 }) },
  ],
  ...over,
});

const urls: string[] = [];
beforeEach(() => {
  localStorage.clear();
  urls.length = 0;
  globalThis.fetch = mock(async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => chain() };
  }) as never;
});
afterEach(cleanup);

const headers = () => within(screen.getAllByRole("row")[1]!).getAllByRole("columnheader").map((h) => h.textContent);

test("shows every column of the Upstox-style chain, mirrored: LTP beside the strike on both sides", async () => {
  render(<OptionChainWidget widget={widget} />);
  await screen.findByText("9,250");
  expect(headers()).toEqual(["Volume", "IV", "Vega", "Gamma", "Theta", "Delta", "OI chg", "OI", "Bid", "Ask", "LTP", "Strike", "LTP", "Ask", "Bid", "OI", "OI chg", "Delta", "Theta", "Gamma", "Vega", "IV", "Volume"]);
  expect(screen.queryByText(/Build Strategy/)).toBeNull();
});

test("the toolbar has the expiry tabs, PCR, max pain and spot; picking an expiry asks for it", async () => {
  render(<OptionChainWidget widget={widget} />);
  await screen.findByText("9,250");
  expect(screen.getAllByRole("tab")).toHaveLength(3);
  expect(screen.getByText("1.30")).toBeTruthy(); // PCR
  expect(urls[0]).toContain("underlying=CRUDEOIL");
  fireEvent.click(screen.getAllByRole("tab")[1]!);
  await waitFor(() => expect(urls.some((u) => u.includes("expiry=2026-12-16"))).toBe(true));
});

test("a spot marker row sits between the strikes either side of spot, and in-the-money cells are shaded", async () => {
  const { container } = render(<OptionChainWidget widget={widget} />);
  await screen.findByText("9,250");
  const rows = [...container.querySelectorAll("tbody tr")].map((r) => r.className || r.textContent);
  const spotAt = rows.findIndex((r) => r === "ocx-spot");
  const idx = (strike: string) => [...container.querySelectorAll("tbody tr")].findIndex((r) => r.textContent?.includes(strike));
  expect(idx("9,250")).toBeLessThan(spotAt);
  expect(idx("9,300")).toBeGreaterThan(spotAt);
  // spot 9286: a call at 9250 is in the money (shaded), a put at 9250 is not; the reverse at 9300
  const r9250 = [...container.querySelectorAll("tbody tr")][idx("9,250")]!.querySelectorAll("td");
  const r9300 = [...container.querySelectorAll("tbody tr")][idx("9,300")]!.querySelectorAll("td");
  expect(r9250[0]!.className).toContain("itm");
  expect(r9250[r9250.length - 1]!.className).not.toContain("itm");
  expect(r9300[0]!.className).not.toContain("itm");
  expect(r9300[r9300.length - 1]!.className).toContain("itm");
});

test("PCR per strike, OI change in colour, and OI percent change under the OI figure", async () => {
  render(<OptionChainWidget widget={widget} />);
  await screen.findByText("9,250");
  expect(screen.getByText("PCR: 1.83")).toBeTruthy(); // 11212 / 6131
  expect(screen.getByText("PCR: —")).toBeTruthy(); // no call OI at 9350
  expect(screen.getByText("+843").className).toContain("up");
  expect(screen.getByText("-49").className).toContain("down");
  expect(screen.getAllByText("+15.94 %").length).toBeGreaterThan(0); // 843 / 5288
});

test("the legend says what the OI baseline is", async () => {
  render(<OptionChainWidget widget={widget} />);
  await screen.findByText("9,250");
  expect(screen.getByText("Yesterday's OI")).toBeTruthy();
  cleanup();
  globalThis.fetch = mock(async () => ({ ok: true, status: 200, json: async () => chain({ oiBasis: "session-open" }) })) as never;
  render(<OptionChainWidget widget={widget} />);
  expect(await screen.findByText(/first reading/)).toBeTruthy();
  cleanup();
  globalThis.fetch = mock(async () => ({ ok: true, status: 200, json: async () => chain({ oiBasis: undefined }) })) as never;
  render(<OptionChainWidget widget={widget} />);
  expect(await screen.findByText(/none recorded yet/)).toBeTruthy();
});

test("Load more asks the API for more strikes each side, up to its limit of 40", async () => {
  render(<OptionChainWidget widget={widget} />);
  await screen.findByText("9,250");
  expect(urls.at(-1)).toContain("strikes=10");
  fireEvent.click(screen.getByRole("button", { name: /Load more strikes/ }));
  await waitFor(() => expect(urls.some((u) => u.includes("strikes=16"))).toBe(true));
  for (let i = 0; i < 6; i++) {
    const b = screen.getByRole("button", { name: /Load more strikes/ }) as HTMLButtonElement;
    if (!b.disabled) fireEvent.click(b);
  }
  await waitFor(() => expect(urls.some((u) => u.includes("strikes=40"))).toBe(true));
  expect((screen.getByRole("button", { name: /Load more strikes/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(urls.some((u) => /strikes=4[1-9]/.test(u))).toBe(false);
});

test("the column chooser hides a column, remembers the choice, and Show all restores them", async () => {
  const { unmount } = render(<OptionChainWidget widget={widget} />);
  await screen.findByText("9,250");
  fireEvent.click(screen.getByText(/Columns/));
  fireEvent.click(screen.getByLabelText("Gamma"));
  expect(headers()).not.toContain("Gamma");
  expect(headers().length).toBe(21);
  unmount();
  render(<OptionChainWidget widget={widget} />); // a new session: the choice is remembered
  await screen.findByText("9,250");
  expect(headers()).not.toContain("Gamma");
  fireEvent.click(screen.getByText(/Columns/));
  fireEvent.click(screen.getByText("Show all"));
  expect(headers()).toContain("Gamma");
});

test("switching the bars to volume drops the OI baseline from the legend", async () => {
  render(<OptionChainWidget widget={widget} />);
  await screen.findByText("9,250");
  fireEvent.click(screen.getByLabelText("Show volume bars"));
  expect(screen.getByText("Today's volume")).toBeTruthy();
  expect(screen.queryByText("Yesterday's OI")).toBeNull();
});

test("an API error is shown instead of a blank panel", async () => {
  globalThis.fetch = mock(async () => ({ ok: false, status: 503, json: async () => ({ message: "Upstox not connected" }) })) as never;
  render(<OptionChainWidget widget={widget} />);
  expect(await screen.findByText(/Upstox not connected/)).toBeTruthy();
});

test("picking a time shows the chain as we recorded it (no live polling, a RECORDED badge, bid and ask sizes), steps between snapshots and goes back to live", async () => {
  const recorded = (asOf: number, prevAt: number | null, nextAt: number | null) =>
    chain({ source: "upstox", oiBasis: "session-open", asOf, prevAt, nextAt, rows: [{ strike: 9300, ce: leg("c", { bidQty: 4, askQty: 6, oi: 777 }), pe: leg("d") }] });
  const T1 = Date.parse("2026-10-26T21:00");
  globalThis.fetch = mock(async (url: string) => {
    urls.push(String(url));
    if (String(url).includes("/feed/chain-view")) {
      const at = Number(new URL(String(url), "http://x").searchParams.get("at"));
      return { ok: true, status: 200, json: async () => (at === T1 ? recorded(T1, T1 - 900_000, null) : recorded(at, null, T1)) };
    }
    return { ok: true, status: 200, json: async () => chain() };
  }) as never;
  render(<OptionChainWidget widget={widget} />);
  await screen.findByText("9,250");
  fireEvent.change(screen.getByLabelText("Show the chain as recorded at"), { target: { value: "2026-10-26T21:00" } });
  await screen.findByText(/RECORDED/);
  expect(urls.some((u) => u.includes(`/feed/chain-view?underlying=CRUDEOIL&at=${T1}`))).toBe(true);
  expect(screen.getByText("×4")).toBeTruthy(); // best bid size
  expect(screen.getByText("×6")).toBeTruthy();
  expect(screen.getByText("recorded snapshot")).toBeTruthy();
  expect(screen.queryByLabelText("Options feed")).toBeNull(); // no live feed choice while looking at a recording
  expect((screen.getByLabelText("Next snapshot") as HTMLButtonElement).disabled).toBe(true); // nothing recorded after the last one

  fireEvent.click(screen.getByLabelText("Previous snapshot"));
  await waitFor(() => expect(urls.some((u) => u.includes(`at=${T1 - 900_000}`))).toBe(true));
  await waitFor(() => expect((screen.getByLabelText("Next snapshot") as HTMLButtonElement).disabled).toBe(false));

  const before = urls.filter((u) => u.includes("/options?")).length;
  fireEvent.click(screen.getByText("Live"));
  await waitFor(() => expect(urls.filter((u) => u.includes("/options?")).length).toBeGreaterThan(before));
  expect(screen.queryByText(/RECORDED/)).toBeNull();
});

test("when nothing was recorded at the chosen time the panel says so and offers the way back to live", async () => {
  globalThis.fetch = mock(async (url: string) =>
    String(url).includes("/feed/chain-view") ? { ok: false, status: 404, json: async () => ({ message: "no snapshot was recorded by then" }) } : { ok: true, status: 200, json: async () => chain() },
  ) as never;
  render(<OptionChainWidget widget={widget} />);
  await screen.findByText("9,250");
  fireEvent.change(screen.getByLabelText("Show the chain as recorded at"), { target: { value: "2020-01-01T10:00" } });
  expect(await screen.findByText("no snapshot was recorded by then")).toBeTruthy();
  fireEvent.click(screen.getByText("Back to live"));
  expect(await screen.findByText("9,250")).toBeTruthy();
});
