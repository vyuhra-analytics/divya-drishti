import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FamilyWidget } from "./FamilyPanel";

// The Family screen over fake API answers: the headline numbers, why the result is what it is, the member comparison, the year chart, every contract, what is
// loaded, the statement for the accountant, and the cards that tell the owner what to do next.
const totals = (realized: number, charges: number) => ({ realized, charges, net: realized - charges, unrealized: 0, profits: Math.max(realized, 0), losses: Math.min(realized, 0), winners: 1, losers: 2, symbols: 3, turnoverAtLeast: 1000 });
const row = (key: string, label: string, realized: number, charges: number, chargesComplete?: boolean) => ({ key, label, ...totals(realized, charges), ...(chargesComplete !== undefined ? { chargesComplete } : {}) });
const overview = {
  members: [{ id: 1, nickname: "Dad", relation: "", hidden: false, note: "" }, { id: 2, nickname: "Unassigned 1", relation: "", hidden: false, note: "" }, { id: 3, nickname: "Unassigned 2", relation: "", hidden: false, note: "" }],
  accounts: [{ id: 10, memberId: 1, broker: "zerodha", label: "Zerodha account", clientCode: "AB1234" }, { id: 20, memberId: 2, broker: "kotak", label: "Kotak account", clientCode: "ZZ9999" }],
  imports: [{ id: 1, accountId: 10, kind: "pnl", segment: "fno", periodFrom: "2024-04-01", periodTo: "2025-03-31", fileName: "pnl-AB1234.xlsx", importedAt: "", rows: 3, problems: [] }],
  coverage: {
    years: ["2024-25", "2025-26"],
    rows: [{ accountId: 10, memberId: 1, cells: { "2024-25": { statements: ["fno"], tradebook: true, partial: false } } }, { accountId: 20, memberId: 2, cells: { "2025-26": { statements: ["fno", "commodity"], tradebook: false, partial: true } } }],
  },
  statementPeriods: ["2024-25"],
};
const contract = (id: string, symbol: string, realized: number, over: object = {}) => ({ id, symbol, underlying: symbol.slice(0, 5), kind: "option", segment: "fno", memberId: 1, accountId: 10, fy: "2024-25", quantity: 25, realized, file: "pnl-AB1234.xlsx", ...over });
const insights = {
  contracts: 7, winners: 3, losers: 4, winRate: 3 / 7, avgWin: 1333.33, avgLoss: -1750, payoff: 0.76, profitFactor: 0.57, expectancy: -428.57, grossProfit: 4000, grossLoss: -7000, charges: 200, chargesOfWinnings: 0.05, chargesOfLosses: 0.0286,
  worst: [contract("w1", "NIFTY24JUN23100PE", -3000), contract("w2", "BANKNIFTY24JUN50000CE", -2000)], best: [contract("b1", "CRUDEOIL 15NOV24 CE 5900", 2500, { segment: "commodity" })], worstFiveShare: 1,
  bySegment: [{ segment: "commodity", contracts: 2, winRate: 0.5, payoff: 5, profitFactor: 5, realized: 2000 }, { segment: "fno", contracts: 5, winRate: 0.4, payoff: 0.5, profitFactor: 0.4, realized: -5000 }],
  verdict: "43% of contracts closed in profit and the average win is 0.76 times the average loss, so the wins do not cover the losses.",
};
const report = {
  summary: {
    totals: totals(-1000, 100),
    byPeriod: [row("2024-25", "2024-25", -1000, 100)],
    byMember: [row("1", "Dad", -600, 60), row("2", "Unassigned 1", -400, 40)],
    byAccount: [row("10", "Dad · Zerodha · Zerodha account", -600, 60)],
    bySegment: [row("fno", "fno", -1000, 100)],
    byUnderlying: [row("NIFTY", "NIFTY", -1000, 0, false), row("CRUDE", "CRUDE", 2000, 40, true)],
    underlyingHasCharges: true,
    chargesByGroup: [{ group: "Brokerage", amount: 100 }],
    imports: [{ id: 1 }] as never,
  },
  monthly: {
    months: [{ month: "2024-06", realized: 250, charges: 20, net: 230, closes: 2 }, { month: "2024-07", realized: -1250, charges: 80, net: -1330, closes: 3 }],
    reconciliation: [{ importId: 1, fileName: "pnl-AB1234.xlsx", ok: false, differences: [{ symbol: "NIFTY24JUL23900PE", statement: -2731.25, tradebook: null, difference: 2731.25, ok: false }] }],
    withoutTradebook: [],
  },
  contracts: [contract("c1", "NIFTY24JUN23000CE", 1000), contract("c2", "NIFTY24JUN23100PE", -3000), contract("c3", "CRUDEOIL 15NOV24 CE 5900", 2500, { segment: "commodity", memberId: 2, charges: 40, net: 2460 })],
  contractsTotal: 3,
  insights,
  yearBySegment: { rows: [{ key: "2024-25", label: "2024-25" }], cols: [{ key: "commodity", label: "Commodity" }, { key: "fno", label: "Futures & Options (Derivatives)" }], cells: { "2024-25": { commodity: { realized: 2000, charges: 50, net: 1950 }, fno: { realized: -5000, charges: 150, net: -5150 } } } },
  memberByYear: { rows: [{ key: "1", label: "Dad" }], cols: [{ key: "2024-25", label: "2024-25" }], cells: { "1": { "2024-25": { realized: -4000, charges: 100, net: -4100 } } } },
};
let requests: string[] = [];

beforeEach(() => {
  requests = [];
  try {
    localStorage.setItem("drishti-family-hide", "0");
  } catch {}
  globalThis.fetch = mock(async (url: string) => {
    const u = String(url);
    requests.push(u);
    if (u.includes("/family/statement")) return { ok: true, json: async () => ({ memberId: 1, fy: "2024-25", accounts: [], segments: [], totals: { contracts: 0, realized: 0, chargesTotal: 0, net: 0, turnoverAtLeast: 0 }, contracts: [], notCut: false }) };
    return { ok: true, json: async () => (u.includes("/family/summary") ? report : overview) };
  }) as never;
});
afterEach(cleanup);

const widget = { id: "fam-1", type: "family" } as never;
const open = async () => {
  const view = render(<FamilyWidget widget={widget} />);
  await waitFor(() => expect(screen.getByText("Net after charges")).toBeTruthy());
  return view;
};

test("the net leads, the years are charted, every member is compared and the unfinished work is spelled out", async () => {
  await open();
  expect(screen.getAllByText("-1,100.00").length).toBeGreaterThan(0); // realised -1,000 less 100 of charges
  expect(screen.getByRole("img", { name: /Net by financial year, 1 years/ })).toBeTruthy();
  expect(screen.getByText("Members")).toBeTruthy();
  expect(screen.getAllByText("Dad").length).toBeGreaterThan(0);
  // a leftover empty member is not worth a card, the one holding an account is
  // several things to check fold into one line that opens: each is still there for the reader
  expect(screen.getByText("2 things to check")).toBeTruthy();
  expect(screen.getAllByText("A member was created from a file").length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Carried-in positions/).length).toBeGreaterThan(0);
  expect(screen.getByText(/NIFTY24JUL23900PE/)).toBeTruthy();
});

test("the insights say why the result is what it is: the sentence, the sizes, the worst and best contracts and each segment", async () => {
  await open();
  expect(screen.getByText("Why the result is what it is")).toBeTruthy();
  expect(screen.getByText(/43% of contracts closed in profit and the average win is 0.76 times/)).toBeTruthy();
  expect(screen.getByText("0.76×")).toBeTruthy();
  expect(screen.getByText("0.57×")).toBeTruthy();
  expect(screen.getByText("Biggest losses")).toBeTruthy();
  expect(screen.getByText("NIFTY24JUN23100PE")).toBeTruthy();
  expect(screen.getByText(/hold 100% of all the losses/)).toBeTruthy();
  expect(screen.getByText("Winnings ÷ losses", { selector: "th" })).toBeTruthy(); // the per-segment table
});

test("the break-down tabs switch what is shown, including the year and member tables and charges known only in part", async () => {
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "Underlying" }));
  const nifty = screen.getByText("NIFTY").closest("tr")!;
  expect(within(nifty).getByText("—")).toBeTruthy(); // no net where only some charges are known
  expect(within(nifty).getByText("0.00*")).toBeTruthy();
  const crude = screen.getByText("CRUDE").closest("tr")!;
  expect(within(crude).getByText("40.00")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Year × segment" }));
  expect(screen.getByText("-5,150")).toBeTruthy();
  expect(screen.getByText("1,950")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Member × year" }));
  expect(screen.getAllByText("-4,100").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("tab", { name: "Charges and taxes" }));
  expect(screen.getByText("Brokerage")).toBeTruthy();
});

test("the contracts tab lists every contract, searches it, sorts by a column and marks charges the statement does not give", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Contracts" }));
  expect(screen.getByText("3 of 3 contracts")).toBeTruthy();
  const body = () => [...document.querySelectorAll(".fam-table tbody tr")].map((r) => r.querySelector("td")!.textContent);
  expect(body()).toEqual(["NIFTY24JUN23100PE", "NIFTY24JUN23000CE", "CRUDEOIL 15NOV24 CE 5900"]); // worst realised first
  fireEvent.click(screen.getByRole("button", { name: /Realised/ }));
  expect(body()[0]).toBe("CRUDEOIL 15NOV24 CE 5900");
  fireEvent.change(screen.getByLabelText("Search contracts"), { target: { value: "crude" } });
  expect(screen.getByText("1 of 3 contracts")).toBeTruthy();
  expect(body()).toEqual(["CRUDEOIL 15NOV24 CE 5900"]);
  expect(screen.getByText("2,460.00")).toBeTruthy(); // Kotak gives the net per contract
  fireEvent.change(screen.getByLabelText("Search contracts"), { target: { value: "NIFTY24JUN23000" } });
  expect(within(document.querySelector(".fam-table tbody tr") as HTMLElement).getAllByText("—").length).toBe(2); // Zerodha: no per-contract charges or net
});

test("files and people shows what is loaded for every account and year, with the partial ones marked", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Files and people" }));
  expect(screen.getByText("What is loaded")).toBeTruthy();
  const cover = document.querySelector(".fam-cover")!;
  expect(within(cover as HTMLElement).getByText("✓ F&O")).toBeTruthy();
  expect(within(cover as HTMLElement).getByText("· months")).toBeTruthy();
  const partial = within(cover as HTMLElement).getByText("✓ F&O + Com");
  expect(partial.className).toBe("fam-part");
  expect(within(cover as HTMLElement).getAllByText("—").length).toBe(2);
});

test("the statement for the accountant is asked for by member and year, and is off while amounts are hidden", async () => {
  await open();
  const open1 = screen.getByRole("button", { name: "Open printable page" }) as HTMLButtonElement;
  expect(open1.disabled).toBe(false);
  URL.createObjectURL = (() => "blob:x") as never;
  URL.revokeObjectURL = (() => undefined) as never;
  const link = HTMLAnchorElement.prototype.click;
  let saved = "";
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    saved = this.download;
  };
  fireEvent.click(screen.getAllByRole("button", { name: "Download CSV" }).find((b) => b.getAttribute("title") === "Download as CSV")!);
  await waitFor(() => expect(requests.some((r) => r.includes("/family/statement?member=1&period=2024-25"))).toBe(true));
  await waitFor(() => expect(saved).toBe("statement-2024-25-Dad.csv"));
  HTMLAnchorElement.prototype.click = link;
  cleanup();
  localStorage.setItem("drishti-family-hide", "1");
  await open();
  expect((screen.getByRole("button", { name: "Open printable page" }) as HTMLButtonElement).disabled).toBe(true);
});

test("with amounts hidden no figure, name or verdict is on screen, not even in the chart's tooltips", async () => {
  localStorage.setItem("drishti-family-hide", "1");
  const { container } = await open();
  expect(container.textContent).not.toMatch(/1,100|NIFTY24JUL|Dad|43%|0\.76/);
  expect(container.querySelectorAll("svg title")).toHaveLength(0);
  expect(screen.getByText(/Turn off Hide names and amounts to read this/)).toBeTruthy();
});

test("an API that has not been restarted since the update still shows the screen, without the newer parts", async () => {
  globalThis.fetch = mock(async (url: string) => {
    const { coverage, statementPeriods, ...old } = overview;
    const { contracts, contractsTotal, insights: _i, yearBySegment, memberByYear, ...oldReport } = report;
    void coverage, statementPeriods, contracts, contractsTotal, _i, yearBySegment, memberByYear;
    return { ok: true, json: async () => (String(url).includes("/family/summary") ? oldReport : old) };
  }) as never;
  await open();
  expect(screen.getByText("Net after charges")).toBeTruthy();
  expect(screen.queryByText("Why the result is what it is")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Contracts" }));
  expect(screen.getByText("No contracts in this selection.")).toBeTruthy();
});
