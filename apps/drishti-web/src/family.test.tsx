import { Change } from "./FamilyExtras";
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
    months: [{ month: "2024-06", realized: 250, charges: 20, net: 230, closes: 2, est: { realized: 0, charges: 0, contracts: 0 } }, { month: "2024-07", realized: -1250, charges: 80, net: -1100, closes: 3, est: { realized: 400, charges: 50, contracts: 2 } }],
    days: [
      { date: "2024-06-12", realized: 250, charges: 20, net: 230, closes: 2, est: { realized: 0, charges: 0, contracts: 0 } },
      { date: "2024-07-10", realized: -1250, charges: 80, net: -1100, closes: 3, est: { realized: 400, charges: 50, contracts: 2 } },
      { date: "2024-07-25", realized: 0, charges: 0, net: -300, closes: 0, est: { realized: -300, charges: 0, contracts: 1 } },
    ],
    reconciliation: [{ importId: 1, fileName: "pnl-AB1234.xlsx", ok: false, differences: [{ symbol: "NIFTY24JUL23900PE", statement: -2731.25, tradebook: null, difference: 2731.25, ok: false }] }],
    withoutTradebook: [{ importId: 1, fileName: "pnl-AB1234.xlsx", periodFrom: "2024-04-01", periodTo: "2025-03-31" }],
    unplaced: { contracts: 0, realized: 0 },
  },
  insights,
  yearBySegment: { rows: [{ key: "2024-25", label: "2024-25" }], cols: [{ key: "commodity", label: "Commodity" }, { key: "fno", label: "Futures & Options (Derivatives)" }], cells: { "2024-25": { commodity: { realized: 2000, charges: 50, net: 1950 }, fno: { realized: -5000, charges: 150, net: -5150 } } } },
  memberByYear: { rows: [{ key: "1", label: "Dad" }], cols: [{ key: "2024-25", label: "2024-25" }], cells: { "1": { "2024-25": { realized: -4000, charges: 100, net: -4100 } } } },
};
const contractRowsMock = [contract("c1", "NIFTY24JUN23000CE", 1000), contract("c2", "NIFTY24JUN23100PE", -3000), contract("c3", "CRUDEOIL 15NOV24 CE 5900", 2500, { segment: "commodity", memberId: 2, charges: 40, net: 2460 })];
let requests: string[] = [];

beforeEach(() => {
  requests = [];
  try {
    localStorage.setItem("drishti-family-hide", "0");
    localStorage.removeItem("drishti-family-view");
  } catch {}
  globalThis.fetch = mock(async (url: string) => {
    const u = String(url);
    requests.push(u);
    if (u.includes("/family/contracts")) return { ok: true, json: async () => ({ contracts: contractRowsMock, total: contractRowsMock.length }) };
    if (u.includes("/family/statement")) return { ok: true, json: async () => ({ memberId: 1, fy: "2024-25", accounts: [], segments: [], totals: { contracts: 0, realized: 0, chargesTotal: 0, net: 0, turnoverAtLeast: 0 }, contracts: [], notCut: false }) };
    return { ok: true, json: async () => (u.includes("/family/summary") ? report : overview) };
  }) as never;
});
afterEach(cleanup);

const widget = { id: "fam-1", type: "family" } as never;
const topBar = () => within(document.querySelector(".fam-top") as HTMLElement); // the year in the statement card has the same label
const open = async () => {
  const view = render(<FamilyWidget widget={widget} />);
  await waitFor(() => expect(screen.getAllByText("Net after charges").length).toBeGreaterThan(0)); // the year-so-far row and the all-years row both carry it
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
  expect(screen.getByText("3 things to check")).toBeTruthy();
  expect(screen.getAllByText("A member was created from a file").length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Carried-in positions/).length).toBeGreaterThan(0);
  expect(screen.getAllByText("Some months are estimated").length).toBeGreaterThan(0);
  expect(screen.getByText(/NIFTY24JUL23900PE/)).toBeTruthy();
});

test("the last trading day leads the overview: its net, the day before, the month so far, and how far the data goes", async () => {
  const day = (date: string, realized: number, charges: number, closes: number) => ({ date, realized, charges, net: realized - charges, closes });
  const lastDay = { ...day("2026-10-27", 1200, 150, 3), previous: day("2026-10-26", -500, 80, 2), monthToDate: 640, asOf: "2026-10-27", byAccount: [{ ...day("2026-10-27", 1000, 100, 2), accountId: 11 }, { ...day("2026-10-27", 200, 50, 1), accountId: 12 }], bySegment: [] };
  const prior = globalThis.fetch;
  globalThis.fetch = mock(async (url: string) => (String(url).includes("/family/summary") ? { ok: true, json: async () => ({ ...report, lastDay }) } : (prior as never as (u: string) => Promise<unknown>)(url))) as never;
  await open();
  const card = within(screen.getByTestId("fam-lastday"));
  expect(card.getByText("Last trading day")).toBeTruthy();
  expect(card.getAllByText(/Tue, 27 Oct,? 2026/).length).toBeGreaterThan(1);
  expect(card.getByText("1,050.00")).toBeTruthy(); // 1,200 realised less 150 charges
  expect(card.getByText(/realised 1,200.00 less charges 150.00 · 3 positions closed/)).toBeTruthy();
  expect(card.getByText(/Mon, 26 Oct,? 2026/)).toBeTruthy();
  expect(card.getByText(/October so far/)).toBeTruthy();
  expect(card.getByText(/Trades loaded up to Tue, 27 Oct,? 2026\. Nothing is loaded after that/)).toBeTruthy(); // the test clock is later than the data
});

test("the year so far, the recent days, each person's last day, the risk figures and the habit tables are drawn from the computed figures", async () => {
  const day = (date: string, net: number, closes = 1) => ({ date, realized: net, charges: 0, net, closes });
  const totals = (net: number) => ({ realized: net, charges: 100, net, unrealized: 0, profits: 500, losses: -400, winners: 3, losers: 2, symbols: 5, turnoverAtLeast: 0 });
  const row = (label: string, n: number, total: number, thin = false) => ({ label, n, total, avg: total / n, winRate: 0.5, thin });
  const extra = {
    lastDay: { ...day("2026-10-27", 1050, 3), previous: day("2026-10-26", -400), monthToDate: 640, recent: [day("2026-10-23", -100), day("2026-10-26", -400), day("2026-10-27", 1050, 3)], byAccount: [], bySegment: [], byMember: [{ ...day("2026-10-27", 1050), memberId: 1 }, { ...day("2026-10-26", -400), memberId: 2 }], asOf: "2026-10-27" },
    fyHeadline: { fy: "2026-27", through: "2026-10-28", totals: totals(777), daysNet: 777, daysNetLastYear: -55, previous: { fy: "2025-26", totals: totals(305) } },
    risk: { days: 10, winDays: 6, lossDays: 4, bestDay: day("2026-09-01", 900), worstDay: day("2026-09-10", -800), streak: { kind: "loss", days: 2 }, maxDrawdown: { amount: 1500, from: "2026-09-01", to: "2026-09-12" }, currentDrawdown: 600 },
    habits: { positions: 40, days: 12, weekday: [row("Monday", 12, 300), row("Friday", 3, -90, true)], hold: [row("Same day", 30, -200)], kind: [row("Bought calls", 25, 100)], busy: [row("3 to 5 positions closed", 6, -120)] },
  };
  const prior = globalThis.fetch;
  globalThis.fetch = mock(async (url: string) => (String(url).includes("/family/summary") ? { ok: true, json: async () => ({ ...report, ...extra, summary: { ...report.summary, byPeriod: [...report.summary.byPeriod, { ...report.summary.byPeriod[0], key: "2025-26", label: "2025-26" }] } }) } : (prior as never as (u: string) => Promise<unknown>)(url))) as never;
  await open();
  const year = within(screen.getByTestId("fam-year"));
  expect(year.getByText(/FY 2026-27 so far/)).toBeTruthy();
  expect(year.getByText(/same stretch of last year: -55.00 · 2025-26 in full: 305.00/)).toBeTruthy();
  expect(screen.getByText("All years together")).toBeTruthy(); // the older totals are labelled as such once a year row leads
  expect(screen.getByRole("img", { name: "Last 3 trading days" })).toBeTruthy();
  expect(within(screen.getByTestId("fam-lastday")).getByLabelText("Each person's latest trading day")).toBeTruthy();
  const risk = within(screen.getByTestId("fam-risk"));
  expect(risk.getByText("2 losing days")).toBeTruthy();
  expect(risk.getByText("900.00")).toBeTruthy();
  expect(risk.getByText(/from 1 Sept?,? 2026 to 12 Sept?,? 2026/)).toBeTruthy();
  const habits = within(screen.getByTestId("fam-habits"));
  expect(habits.getByText(/40 positions closed in the dated tradebooks, over 12 trading days/)).toBeTruthy();
  expect(habits.getByText("Friday *")).toBeTruthy(); // under five is marked
  expect(habits.getByText("Bought calls")).toBeTruthy();
  expect(screen.getByText(/Trades to 27 Oct,? 2026/)).toBeTruthy();
});

test("each headline card shows what the last trading day did to it: an arrow for the direction, a colour for good or bad, and a running line behind it", async () => {
  const row = (date: string, realized: number, charges: number) => ({ date, realized, charges, net: realized - charges, closes: 1, est: { realized: 0, charges: 0, contracts: 0 } });
  const days = [row("2026-10-23", 100, 10), row("2026-10-26", -400, 20), row("2026-10-27", 300, 15), row("2026-10-28", 950, 193.25)];
  const totals = (net: number) => ({ realized: net, charges: 100, net, unrealized: 0, profits: 500, losses: -400, winners: 3, losers: 2, symbols: 5, turnoverAtLeast: 0 });
  const extra = {
    lastDay: { date: "2026-10-28", realized: 950, charges: 193.25, net: 756.75, closes: 6, monthToDate: 640, recent: days.map((d) => ({ date: d.date, realized: d.realized, charges: d.charges, net: d.net, closes: 1 })), byAccount: [], bySegment: [], byMember: [], asOf: "2026-10-28" },
    fyHeadline: { fy: "2026-27", through: "2026-10-29", totals: totals(777), daysNet: 777, daysNetLastYear: null, previous: null },
    monthly: { ...report.monthly, days },
  };
  const prior = globalThis.fetch;
  globalThis.fetch = mock(async (url: string) => (String(url).includes("/family/summary") ? { ok: true, json: async () => ({ ...report, ...extra }) } : (prior as never as (u: string) => Promise<unknown>)(url))) as never;
  await open();
  // realised and net went up (good), charges went up (bad): both the year row and the all-years row carry the three chips
  expect(screen.getAllByLabelText(/^Up 950\.00 on 28 Oct,? 2026, good$/)).toHaveLength(2);
  expect(screen.getAllByLabelText(/^Up 193\.25 on 28 Oct,? 2026, bad$/)).toHaveLength(2);
  expect(screen.getAllByLabelText(/^Up 756\.75 on 28 Oct,? 2026, good$/)).toHaveLength(2);
  expect(screen.getAllByRole("img", { name: /Running total over the last 4 days/ }).length).toBeGreaterThanOrEqual(3);
});

test("the change chip: a loss is a down arrow in the bad colour, more cost is bad and less cost is good, and hidden amounts keep the direction", () => {
  const fmt = { hide: false, money: (n: number) => n.toFixed(2), signed: (n: number) => String(n) };
  const { rerender } = render(<Change amount={-300} kind="pnl" day="2026-10-28" fmt={fmt} />);
  expect(screen.getByLabelText(/^Down 300\.00 on 28 Oct,? 2026, bad$/)).toBeTruthy();
  rerender(<Change amount={-30} kind="cost" day="2026-10-28" fmt={fmt} />);
  expect(screen.getByLabelText(/^Down 30\.00 on 28 Oct,? 2026, good$/)).toBeTruthy();
  rerender(<Change amount={0} kind="pnl" day="2026-10-28" fmt={fmt} />);
  expect(screen.getByLabelText(/^Unchanged on 28 Oct,? 2026, no change$/)).toBeTruthy();
  rerender(<Change amount={500} kind="pnl" day="2026-10-28" fmt={{ ...fmt, hide: true }} />);
  const hidden = screen.getByLabelText(/^Up on 28 Oct,? 2026, good$/); // the amount is gone, the direction stays
  expect(hidden.textContent).toContain("••••");
  expect(hidden.textContent).not.toContain("500");
});

test("a single note folds into one line instead of a banner", async () => {
  await open();
  const folded = document.querySelector("details.fam-alerts") as HTMLElement;
  expect(folded).toBeTruthy();
});

test("with no dated trades the last-day card says what to add instead of showing a zero", async () => {
  await open();
  expect(within(screen.getByTestId("fam-lastday")).getByText(/No dated trades are loaded/)).toBeTruthy();
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
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Underlying" }));
  const nifty = screen.getByText("NIFTY").closest("tr")!;
  expect(within(nifty).getByText("—")).toBeTruthy(); // no net where only some charges are known
  expect(within(nifty).getByText("0.00*")).toBeTruthy();
  const crude = screen.getByText("CRUDE").closest("tr")!;
  expect(within(crude).getByText("40.00")).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Year × segment" }));
  expect(screen.getByText("-5,150")).toBeTruthy();
  expect(screen.getByText("1,950")).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Member × year" }));
  expect(screen.getAllByText("-4,100").length).toBeGreaterThan(0);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Charges and taxes" }));
  expect(screen.getByText("Brokerage")).toBeTruthy();
});

test("the contracts tab lists every contract, searches it, sorts by a column and marks charges the statement does not give", async () => {
  await open();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Contracts" }));
  await waitFor(() => expect(screen.getByText("3 of 3 contracts")).toBeTruthy()); // fetched when the tab opens
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
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Files and people" }));
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
    const { insights: _i, yearBySegment, memberByYear, ...oldReport } = report;
    void coverage, statementPeriods, _i, yearBySegment, memberByYear;
    if (String(url).includes("/family/contracts")) return { ok: false, status: 404, json: async () => ({ message: "Cannot GET /family/contracts" }) };
    return { ok: true, json: async () => (String(url).includes("/family/summary") ? oldReport : old) };
  }) as never;
  await open();
  expect(screen.getByText("Net after charges")).toBeTruthy();
  expect(screen.queryByText("Why the result is what it is")).toBeNull();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Contracts" }));
  await waitFor(() => expect(screen.getAllByRole("alert").some((a) => /Cannot GET \/family\/contracts/.test(a.textContent ?? ""))).toBe(true)); // said plainly, the rest of the screen still works
});

test("the months tab draws every day of the financial year as a square, coloured by the result, with the estimates marked, above the month table", async () => {
  await open();
  // the overview keeps the month bars with the running total
  expect(screen.getAllByRole("img", { name: /Net by month, 2 months/ }).length).toBeGreaterThan(0);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Months" }));
  const cal = screen.getByRole("img", { name: /Daily results for 2024-25: 1 profit days, 2 loss days/ });
  expect(cal.querySelectorAll("rect.fam-hm")).toHaveLength(365); // April 2024 to March 2025, a square for every day
  expect(cal.querySelectorAll("rect.fam-hm.up")).toHaveLength(1);
  expect(cal.querySelectorAll("rect.fam-hm.down")).toHaveLength(2);
  expect(cal.querySelectorAll("rect.fam-hm.est")).toHaveLength(2); // two days carry contracts placed by expiry
  expect(cal.querySelectorAll("rect.fam-hm.none").length).toBe(362);
  expect([...cal.querySelectorAll("text")].map((x) => x.textContent)).toEqual(["APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC", "JAN", "FEB", "MAR"]);
  const day = [...cal.querySelectorAll("rect.fam-hm")].find((r) => r.textContent?.startsWith("2024-07-10"))!;
  expect(day.textContent).toMatch(/-1,100.00 · 3 closed and 2 placed by expiry/);
  expect(screen.getByText(/placed by contract expiry date \(an estimate\)/)).toBeTruthy();
  // the table below still splits what a tradebook proves from what is placed by expiry
  const jul = screen.getByText("2024-07").closest("tr")!;
  expect(within(jul).getByText("-1,250.00")).toBeTruthy();
  expect(within(jul).getByText("400.00")).toBeTruthy();
  expect(within(jul).getByText("-1,100.00")).toBeTruthy();
  expect(screen.getByText(/The months add up to the totals/)).toBeTruthy();
});

test("with amounts hidden the calendar still shows where the days are, but no figure or tooltip", async () => {
  localStorage.setItem("drishti-family-hide", "1");
  const { container } = await open();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Months" }));
  const cal = screen.getByRole("img", { name: /Daily results for 2024-25 \(values hidden\)/ });
  expect(cal.querySelectorAll("title")).toHaveLength(0);
  expect(container.textContent).not.toMatch(/-1,100|profit days/);
});

test("the contracts are fetched only when their tab is open, and the files and people are not read again when a filter changes", async () => {
  await open();
  const count = (needle: string) => requests.filter((r) => r.includes(needle)).length;
  expect(count("/family/contracts")).toBe(0); // the overview does not need them
  expect(count("/family/summary")).toBe(1);
  const overviewReads = requests.filter((r) => r.endsWith("/family")).length;
  fireEvent.change(topBar().getByLabelText("Year"), { target: { value: "2024-25" } });
  await waitFor(() => expect(count("/family/summary")).toBe(2));
  expect(requests.filter((r) => r.endsWith("/family")).length).toBe(overviewReads); // members and files did not change, so they are not asked again
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Contracts" }));
  await waitFor(() => expect(count("/family/contracts")).toBe(1));
  expect(requests.some((r) => r.includes("/family/contracts?period=2024-25"))).toBe(true); // with the filter that is on
  fireEvent.change(topBar().getByLabelText("Year"), { target: { value: "" } });
  await waitFor(() => expect(count("/family/contracts")).toBe(2)); // the open tab follows the filter
});

test("a slow answer for an earlier selection never replaces the answer for the one on screen", async () => {
  const slow: { release?: () => void } = {};
  const earlier = { ...report, summary: { ...report.summary, totals: totals(111, 0) } };
  const later = { ...report, summary: { ...report.summary, totals: totals(222, 0) } };
  globalThis.fetch = mock(async (url: string) => {
    const u = String(url);
    if (u.includes("/family/summary?member=1")) {
      await new Promise<void>((r) => (slow.release = r)); // the first selection answers last
      return { ok: true, json: async () => earlier };
    }
    if (u.includes("/family/summary?member=2")) return { ok: true, json: async () => later };
    return { ok: true, json: async () => (u.includes("/family/summary") ? report : overview) };
  }) as never;
  await open();
  fireEvent.change(topBar().getByLabelText("Member"), { target: { value: "1" } });
  fireEvent.change(topBar().getByLabelText("Member"), { target: { value: "2" } });
  await waitFor(() => expect(screen.getAllByText("222.00").length).toBeGreaterThan(0));
  slow.release?.();
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.queryAllByText("111.00")).toHaveLength(0);
  expect(screen.getAllByText("222.00").length).toBeGreaterThan(0);
});

test("the view the owner left is remembered: the tab, the year, the member and the break-down come back after a reload", async () => {
  localStorage.setItem("drishti-family-view", JSON.stringify({ tab: "contracts", period: "2024-25", memberId: "1", segment: "fno", cut: "underlying" }));
  render(<FamilyWidget widget={widget} />);
  await waitFor(() => expect(screen.getByText("3 of 3 contracts")).toBeTruthy());
  expect((topBar().getByLabelText("Year") as HTMLSelectElement).value).toBe("2024-25");
  expect((topBar().getByLabelText("Member") as HTMLSelectElement).value).toBe("1");
  expect(requests.some((r) => r.includes("/family/contracts?period=2024-25&member=1&segment=fno"))).toBe(true);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Months" }));
  expect(JSON.parse(localStorage.getItem("drishti-family-view")!)).toMatchObject({ tab: "months", period: "2024-25", memberId: "1" });
  cleanup();
  // a remembered member that no longer exists is dropped instead of leaving an empty screen
  localStorage.setItem("drishti-family-view", JSON.stringify({ tab: "overview", period: "", memberId: "99", segment: "", cut: "account" }));
  await open();
  await waitFor(() => expect((topBar().getByLabelText("Member") as HTMLSelectElement).value).toBe(""));
});

test("a long list of contracts is drawn in pieces, with the rest one press away, and a search narrows it", async () => {
  const many = Array.from({ length: 450 }, (_, i) => contract(`m${i}`, `NIFTY24JUN${20000 + i}CE`, i - 200));
  globalThis.fetch = mock(async (url: string) => {
    const u = String(url);
    if (u.includes("/family/contracts")) return { ok: true, json: async () => ({ contracts: many, total: 450 }) };
    return { ok: true, json: async () => (u.includes("/family/summary") ? report : overview) };
  }) as never;
  await open();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Contracts" }));
  await waitFor(() => expect(screen.getByText("450 of 450 contracts")).toBeTruthy());
  const rowsShown = () => document.querySelectorAll(".fam-contracts tbody tr").length;
  expect(rowsShown()).toBe(100);
  fireEvent.click(screen.getByRole("button", { name: /Show 200 more \(350 not shown\)/ }));
  expect(rowsShown()).toBe(300);
  fireEvent.change(screen.getByLabelText("Search contracts"), { target: { value: "20449" } });
  expect(rowsShown()).toBe(1);
  expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
});
