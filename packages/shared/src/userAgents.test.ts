import { expect, test } from "bun:test";
import { uaHeader, USER_AGENTS, userAgentFor } from "./userAgents";

test("the pool is ordinary browser strings", () => {
  expect(USER_AGENTS.length).toBeGreaterThanOrEqual(4);
  for (const ua of USER_AGENTS) expect(ua.startsWith("Mozilla/5.0 (")).toBe(true);
  expect(new Set(USER_AGENTS).size).toBe(USER_AGENTS.length);
});

test("a host gets the same UA every time within a process, whether given as a host or a URL", () => {
  const a = userAgentFor("query1.finance.yahoo.com");
  expect(userAgentFor("query1.finance.yahoo.com")).toBe(a);
  expect(userAgentFor("https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1m")).toBe(a);
  expect(USER_AGENTS).toContain(a as never);
  expect(uaHeader("scanner.tradingview.com")).toEqual({ "User-Agent": userAgentFor("scanner.tradingview.com") });
});

test("different hosts spread over the pool, and a different seed (a restart) can change the choice", () => {
  const hosts = ["a.example", "b.example", "c.example", "d.example", "e.example", "f.example", "g.example", "h.example", "i.example", "j.example"];
  const used = new Set(hosts.map((h) => userAgentFor(h, 1)));
  expect(used.size).toBeGreaterThan(1); // not one string for everything
  const same = hosts.filter((h) => userAgentFor(h, 1) === userAgentFor(h, 2));
  expect(same.length).toBeLessThan(hosts.length); // some host changes with the seed
  expect(userAgentFor("a.example", 7)).toBe(userAgentFor("a.example", 7)); // deterministic for a given seed
});

import { withUserAgent } from "./userAgents";

test("withUserAgent adds the pool UA unless the caller set one", () => {
  const added = withUserAgent("https://oilprice.com/rss/main", { headers: { Accept: "text/xml" } });
  expect((added.headers as Record<string, string>)["User-Agent"]).toBe(userAgentFor("oilprice.com"));
  expect((added.headers as Record<string, string>).Accept).toBe("text/xml");
  expect(withUserAgent("https://x.example").headers).toEqual({ "User-Agent": userAgentFor("x.example") });
  const own = { headers: { "user-agent": "DivyaDrishti me@example.com" } };
  expect(withUserAgent("https://x.example/x", own)).toBe(own); // an honest contact UA is left alone
});

test("official data hosts get no browser User-Agent at all (FRED stalls on one)", () => {
  for (const url of ["https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL", "https://ir.eia.gov/wpsr/table1.csv", "https://publicreporting.cftc.gov/resource/x.json"]) {
    const init = { signal: undefined };
    expect(withUserAgent(url, init)).toBe(init);
  }
  expect((withUserAgent("https://news.google.com/rss/search?q=oil").headers as Record<string, string>)["User-Agent"]).toContain("Mozilla/5.0");
});
