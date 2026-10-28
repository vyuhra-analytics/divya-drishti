import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FamilyWidget } from "./FamilyPanel";

// The Family screen over fake API answers: the headline numbers, the member comparison, the month chart, and the cards that tell the owner what to do next.
const totals = (realized: number, charges: number) => ({ realized, charges, net: realized - charges, unrealized: 0, profits: Math.max(realized, 0), losses: Math.min(realized, 0), winners: 1, losers: 2, symbols: 3, turnoverAtLeast: 1000 });
const row = (key: string, label: string, realized: number, charges: number) => ({ key, label, ...totals(realized, charges) });
const overview = {
  members: [{ id: 1, nickname: "Dad", relation: "", hidden: false, note: "" }, { id: 2, nickname: "Unassigned 1", relation: "", hidden: false, note: "" }, { id: 3, nickname: "Unassigned 2", relation: "", hidden: false, note: "" }],
  accounts: [{ id: 10, memberId: 1, broker: "zerodha", label: "Trading account", clientCode: "AB1234" }, { id: 20, memberId: 2, broker: "zerodha", label: "Trading account", clientCode: "ZZ9999" }],
  imports: [{ id: 1, accountId: 10, kind: "pnl", segment: "fno", periodFrom: "2024-04-01", periodTo: "2025-03-31", fileName: "pnl-AB1234.xlsx", importedAt: "", rows: 3, problems: [] }],
};
const report = {
  summary: {
    totals: totals(-1000, 100),
    byPeriod: [row("2024-25", "2024-25", -1000, 100)],
    byMember: [row("1", "Dad", -600, 60), row("2", "Unassigned 1", -400, 40)],
    byAccount: [row("10", "Dad · Zerodha · Trading account", -600, 60)],
    bySegment: [row("fno", "fno", -1000, 100)],
    byUnderlying: [row("NIFTY", "NIFTY", -1000, 0)],
    chargesByGroup: [{ group: "Brokerage", amount: 100 }],
    imports: [],
  },
  monthly: {
    months: [{ month: "2024-06", realized: 250, charges: 20, net: 230, closes: 2 }, { month: "2024-07", realized: -1250, charges: 80, net: -1330, closes: 3 }],
    reconciliation: [{ importId: 1, fileName: "pnl-AB1234.xlsx", ok: false, differences: [{ symbol: "NIFTY24JUL23900PE", statement: -2731.25, tradebook: null, difference: 2731.25, ok: false }] }],
    withoutTradebook: [],
  },
};
report.summary.imports = [{ id: 1 }] as never; // the screen only needs the list to be non-empty

beforeEach(() => {
  try {
    localStorage.setItem("drishti-family-hide", "0");
  } catch {}
  globalThis.fetch = mock(async (url: string) => ({ ok: true, json: async () => (String(url).includes("/family/summary") ? report : overview) })) as never;
});
afterEach(cleanup);

const widget = { id: "fam-1", type: "family" } as never;

test("the net leads, the months are charted, every member is compared and the unfinished work is spelled out", async () => {
  render(<FamilyWidget widget={widget} />);
  await waitFor(() => expect(screen.getByText("Net after charges")).toBeTruthy());
  expect(screen.getAllByText("-1,100.00").length).toBeGreaterThan(0); // realised -1,000 less 100 of charges
  expect(screen.getByRole("img", { name: /Net by month, 2 months/ })).toBeTruthy();
  expect(screen.getByText("Members")).toBeTruthy();
  expect(screen.getAllByText("Dad").length).toBeGreaterThan(0);
  // a leftover empty member is not worth a card, the one holding an account is
  expect(screen.getByText("A member was created from a file")).toBeTruthy();
  expect(screen.getByText(/Carried-in positions/)).toBeTruthy();
  expect(screen.getByText(/NIFTY24JUL23900PE/)).toBeTruthy();
});

test("with amounts hidden no figure, name or symbol is on screen, not even in the chart's tooltips", async () => {
  localStorage.setItem("drishti-family-hide", "1");
  const { container } = render(<FamilyWidget widget={widget} />);
  await waitFor(() => expect(screen.getByText("Net after charges")).toBeTruthy());
  expect(container.textContent).not.toMatch(/1,100|NIFTY24JUL|Dad/);
  expect(container.querySelectorAll("svg title")).toHaveLength(0);
});

test("the break-down tabs switch what is shown below the members", async () => {
  render(<FamilyWidget widget={widget} />);
  await waitFor(() => expect(screen.getByText("Net after charges")).toBeTruthy());
  fireEvent.click(screen.getByRole("tab", { name: "Underlying" }));
  expect(screen.getByText("NIFTY")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Charges and taxes" }));
  expect(screen.getByText("Brokerage")).toBeTruthy();
});
