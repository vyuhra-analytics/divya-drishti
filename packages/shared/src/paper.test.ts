import { expect, test } from "bun:test";
import { roundTrip } from "./costs";
import { closePaper, exitHit, fillPrice, openPaper, summarizeAccount, unrealisedNet, type PaperPosition } from "./paper";

const q = { price: 9400, bid: 9399, ask: 9401 };
const input = { id: "p1", symbol: "MCX:CRUDEOIL", side: "buy" as const, lots: 2, units: 100 };

test("fills cross the book when depth is known and add slippage, else use the last price", () => {
  expect(fillPrice("buy", q, 1)).toBe(9402);
  expect(fillPrice("sell", q, 1)).toBe(9398);
  expect(fillPrice("buy", { price: 9400 }, 0)).toBe(9400);
  expect(fillPrice("sell", { price: 9400 }, 2)).toBe(9398);
});

test("openPaper fills and validates lots, stop and target sides", () => {
  const p = openPaper({ ...input, stop: 9380, target: 9450 }, q, 0, 5) as PaperPosition;
  expect(p).toMatchObject({ entry: 9401, stop: 9380, target: 9450, lots: 2, openedAt: 5 });
  expect(openPaper({ ...input, stop: 9410 }, q, 0, 5)).toHaveProperty("error"); // long stop above the fill
  expect(openPaper({ ...input, target: 9390 }, q, 0, 5)).toHaveProperty("error");
  expect(openPaper({ ...input, side: "sell", stop: 9390 }, q, 0, 5)).toHaveProperty("error"); // short stop below the fill
  expect(openPaper({ ...input, side: "sell", stop: 9420, target: 9350 }, q, 0, 5)).toMatchObject({ entry: 9399 });
  expect(openPaper({ ...input, lots: 0 }, q, 0, 5)).toHaveProperty("error");
  expect(openPaper({ ...input, lots: 1.5 }, q, 0, 5)).toHaveProperty("error");
});

test("exitHit: stop and target on the right side, stop first when both are reached", () => {
  const long = openPaper({ ...input, stop: 9380, target: 9450 }, q, 0, 0) as PaperPosition;
  expect(exitHit(long, 9400)).toBeUndefined();
  expect(exitHit(long, 9380)).toBe("stop");
  expect(exitHit(long, 9300)).toBe("stop");
  expect(exitHit(long, 9450)).toBe("target");
  const short = openPaper({ ...input, side: "sell", stop: 9420, target: 9350 }, q, 0, 0) as PaperPosition;
  expect(exitHit(short, 9420)).toBe("stop");
  expect(exitHit(short, 9349)).toBe("target");
  expect(exitHit({ ...long, stop: 9460, target: 9450 }, 9455)).toBe("stop"); // both in reach: the worse one
});

test("closePaper fills at the market (a gap through the stop is not rescued) and charges full costs", () => {
  const p = openPaper({ ...input, stop: 9380 }, q, 0, 0) as PaperPosition; // entry 9401
  const gap = { price: 9360, bid: 9359, ask: 9361 };
  const t = closePaper(p, gap, 0, 99, "stop");
  expect(t.exit).toBe(9359); // sold at the bid, below the 9380 stop
  expect(t.reason).toBe("stop");
  const rt = roundTrip("future", "buy", 9401, 9359, 100, 2);
  expect(t.gross).toBeCloseTo(rt.gross, 9);
  expect(t.costs).toBeCloseTo(rt.costs.total, 9);
  expect(t.net).toBeCloseTo(rt.net, 9);
  expect(t.closedAt).toBe(99);
  expect(unrealisedNet(p, gap, 0)).toBeCloseTo(rt.net, 9);
});

test("summarizeAccount adds realised and open P&L and finds the drawdown", () => {
  const t = (net: number, costs = 100) => ({ id: "x", symbol: "s", side: "buy" as const, lots: 1, units: 1, entry: 1, exit: 1, openedAt: 0, closedAt: 1, gross: net + costs, costs, net, reason: "manual" as const, note: "" });
  const a = summarizeAccount(500_000, [t(1000), t(-400), t(-300), t(200)], [150, -50]);
  expect(a.realised).toBe(500);
  expect(a.unrealised).toBe(100);
  expect(a.equity).toBe(500_600);
  expect(a.costsPaid).toBe(400);
  expect(a.winRate).toBe(0.5);
  expect(a.maxDrawdown).toBe(700); // from the 1000 peak down to 300
  expect(summarizeAccount(1000, [], [])).toMatchObject({ equity: 1000, trades: 0, winRate: 0, maxDrawdown: 0 });
});
