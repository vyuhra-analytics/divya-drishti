import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { financeCalendar, matchSeries, mergeSourceRows, parseFinanceCalendar, parseYahooCalendar, SOURCE_WINDOW, yahooCalendar, type SourceRow } from "./calendarSources";
import { naturalKey, planEvent, type PlannedEvent } from "./eventPlan";
import { seriesByCode } from "./eventSeries";
import { replayIO, type Recorded } from "./fixtures";

const recorded = (id: string): Recorded[] => JSON.parse(readFileSync(join(import.meta.dir, `../fixtures/${id}.json`), "utf8"));

describe("Finance Calendar", () => {
  const rows = parseFinanceCalendar(JSON.parse(recorded("finance-calendar")[0].text));

  it("reads the real response: codes, release times in UTC, and the figures it has", () => {
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((r) => r.source === "Finance Calendar" && r.code && Number.isFinite(r.at))).toBe(true);
    expect(rows.some((r) => r.code === "us-eia-natural-gas" || r.code === "us-eia-petroleum")).toBe(true);
  });

  it("an event without a release time or a code is skipped, and empty or null figures are absent, not empty strings", () => {
    const out = parseFinanceCalendar({ events: [{ series_code: "a", title: "x", release_at_utc: null }, { title: "no code", release_at_utc: "2026-10-22T14:30:00+00:00" }, { series_code: "b", title: "y", release_at_utc: "2026-10-22T14:30:00+00:00", consensus: "", prior: "3.4", actual: "null" }] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: "b", previous: "3.4", forecast: undefined, actual: undefined });
    expect(parseFinanceCalendar({})).toEqual([]);
    expect(parseFinanceCalendar(null)).toEqual([]);
  });

  it("fetches through the injected IO, replayed from the recording", async () => {
    const io = replayIO(recorded("finance-calendar"));
    const got = await financeCalendar.fetch(io, io.now() - SOURCE_WINDOW.back, io.now() + SOURCE_WINDOW.ahead);
    expect(got.length).toBe(rows.length);
  });

  it("says where it comes from", () => expect(financeCalendar.attribution).toMatch(/financecalendar\.com/));
});

describe("Yahoo Finance calendar", () => {
  it("fetches with its cookie and crumb, replayed from the recording, and reads the rows", async () => {
    const io = replayIO(recorded("yahoo-calendar"));
    const rows = await yahooCalendar().fetch(io, io.now() - SOURCE_WINDOW.back, io.now() + SOURCE_WINDOW.ahead);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((r) => r.source === "Yahoo Finance" && r.country === "US" && Number.isFinite(r.at))).toBe(true);
  });

  it("parses columns by id, so a reordered response still reads", () => {
    const json = { finance: { result: [{ documents: [{ columns: [{ id: "startdatetime" }, { id: "econ_release" }, { id: "after_release_actual" }, { id: "country_code" }], rows: [["2026-10-22T14:30:00.000Z", "EIA-Nat Gas Chg Bcf*", "77", "US"]] }] }] } };
    expect(parseYahooCalendar(json)).toEqual([{ source: "Yahoo Finance", code: "EIA-Nat Gas Chg Bcf*", title: "EIA-Nat Gas Chg Bcf*", country: "US", at: Date.UTC(2026, 9, 22, 14, 30), forecast: undefined, previous: undefined, actual: "77" }]);
    expect(parseYahooCalendar({})).toEqual([]);
    expect(parseYahooCalendar({ finance: { result: [{ documents: [{ columns: [{ id: "x" }], rows: [["a"]] }] }] } })).toEqual([]);
  });

  it("a refused crumb is renewed once, and an error status is an error", async () => {
    const calls: string[] = [];
    let first = true;
    const io = {
      env: {},
      now: () => Date.UTC(2026, 9, 22),
      fetch: async (url: string | URL) => {
        const u = String(url);
        calls.push(u.includes("visualization") ? "viz" : u.includes("getcrumb") ? "crumb" : "cookie");
        if (u.includes("fc.yahoo.com")) return new Response("", { status: 404, headers: { "set-cookie": "A3=x; Path=/" } });
        if (u.includes("getcrumb")) return new Response("abc123");
        if (first) {
          first = false;
          return new Response("{}", { status: 401 });
        }
        return new Response(JSON.stringify({ finance: { result: [{ documents: [{ columns: [{ id: "econ_release" }, { id: "startdatetime" }], rows: [["A", "2026-10-22T14:30:00.000Z"]] }] }] } }), { status: 200 });
      },
    };
    const rows = await yahooCalendar().fetch(io as never, 0, 1);
    expect(rows).toHaveLength(1);
    expect(calls.filter((c) => c === "crumb")).toHaveLength(2); // renewed after the 401
    const failing = { ...io, fetch: async (u: string | URL) => (String(u).includes("fc.yahoo") ? new Response("", { status: 404 }) : String(u).includes("getcrumb") ? new Response("abc") : new Response("x", { status: 500 })) };
    await expect(yahooCalendar().fetch(failing as never, 0, 1)).rejects.toThrow(/HTTP 500/);
  });
});

describe("matching and merging into planned events", () => {
  const wngsr = seriesByCode("WNGSR")!;
  const release = Date.UTC(2026, 9, 22, 14, 30);
  const planned = (): PlannedEvent[] => [planEvent({ id: `eia-gas-${release}`, title: "EIA natural gas storage", at: release, kind: "energy", impact: "high", forecast: "80B", previous: "67B", src: { forecast: "Forex Factory" } })!];
  const row = (o: Partial<SourceRow>): SourceRow => ({ source: "Yahoo Finance", code: "EIA-Nat Gas Chg Bcf*", title: "x", country: "US", at: release, ...o });

  it("matches a source code to a series by alias, for that source only, and only in the series country", () => {
    expect(matchSeries("yahoo", row({}))?.code).toBe("WNGSR");
    expect(matchSeries("financecalendar", { code: "us-eia-natural-gas", country: "US" })?.code).toBe("WNGSR");
    expect(matchSeries("financecalendar", row({}))).toBeUndefined(); // a Yahoo name means nothing to Finance Calendar
    expect(matchSeries("yahoo", row({ country: "JP" }))).toBeUndefined();
  });

  it("adds the figures and the release time under the source name, beside the existing ones", () => {
    const p = planned();
    expect(mergeSourceRows(p, "yahoo", [row({ actual: "77", previous: "67" })])).toEqual({ used: 1, dropped: 0 });
    const by = (kind: string) => p[0].observations.filter((o) => o.kind === kind).map((o) => [o.source, o.text]);
    expect(by("actual")).toEqual([["Yahoo Finance", "77"]]);
    expect(by("previous")).toEqual([["Forex Factory", "67B"], ["Yahoo Finance", "67"]]); // two sources, two figures, nothing overwritten
    expect(by("release_time")).toEqual([["Yahoo Finance", "2026-10-22T14:30:00.000Z"]]);
    expect(p[0].observations.find((o) => o.kind === "actual")!.num).toBe(77);
  });

  it("a row for a release that is not planned, or for no series, is dropped and creates nothing", () => {
    const p = planned();
    const other = Date.UTC(2026, 10, 12, 15, 30);
    expect(mergeSourceRows(p, "yahoo", [row({ at: other, actual: "1" }), row({ code: "Retail Sales MM", actual: "0.8" })])).toEqual({ used: 0, dropped: 2 });
    expect(p).toHaveLength(1);
    expect(p[0].observations.some((o) => o.kind === "actual")).toBe(false);
  });

  it("merging twice adds nothing the second time", () => {
    const p = planned();
    mergeSourceRows(p, "yahoo", [row({ actual: "77" })]);
    const n = p[0].observations.length;
    mergeSourceRows(p, "yahoo", [row({ actual: "77" })]);
    expect(p[0].observations).toHaveLength(n);
  });

  it("a holiday-shifted release of the same week still finds its event (the key is the week, not the time)", () => {
    const p = planned();
    expect(naturalKey(wngsr, release + 86_400_000)).toBe(naturalKey(wngsr, release));
    expect(mergeSourceRows(p, "yahoo", [row({ at: release + 86_400_000, actual: "77" })]).used).toBe(1);
  });
});
