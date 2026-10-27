import { describe, expect, it } from "bun:test";
import { INVESTING_BLOCK_MS, INVESTING_PAGES, investingProblem, parseInvestingEvent, shouldFetchInvesting } from "./investingCalendar";

// the shape of the real page's state (2026-10-27), trimmed to what the parser reads
const page = (occurrences: unknown[]) => `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { economicCalendarEventStore: { event: {}, occurrences } } } } })}</script></head><body></body></html>`;
const occ = (id: number, time: string, over: object = {}) => ({ event_id: 75, occurrence_id: id, occurrence_time: time, forecast: -0.1, previous: -8.557, unit: "M", precision: 3, ...over });

describe("parseInvestingEvent", () => {
  it("reads every occurrence with its time, forecast, previous and actual, oldest first", () => {
    const rows = parseInvestingEvent(page([occ(3, "2026-10-28T14:30:00Z", { forecast: -0.3, previous: -3.06 }), occ(2, "2026-10-21T14:30:00Z", { actual: -3.06, forecast: -0.1, previous: -8.557 })]))!;
    expect(rows.map((r) => r.occurrenceId)).toEqual([2, 3]);
    expect(rows[0]).toEqual({ occurrenceId: 2, at: Date.parse("2026-10-21T14:30:00Z"), forecast: -0.1, previous: -8.557, actual: -3.06, unit: "M" });
    expect(rows[1]).toMatchObject({ forecast: -0.3, previous: -3.06, actual: undefined }); // not out yet
  });

  it("leaves a missing forecast absent instead of zero, and skips a row with no usable time or id", () => {
    const rows = parseInvestingEvent(page([occ(1, "2026-10-14T20:30:00Z", { forecast: undefined, actual: -11.12 }), occ(2, "garbage"), { occurrence_time: "2026-10-01T14:30:00Z" }]))!;
    expect(rows).toHaveLength(1);
    expect(rows[0].forecast).toBeUndefined();
    expect(rows[0].actual).toBe(-11.12);
  });

  it("is undefined for anything that is not an event page: no state, a different shape, broken JSON", () => {
    expect(parseInvestingEvent("<html>Access denied</html>")).toBeUndefined();
    expect(parseInvestingEvent(`<script id="__NEXT_DATA__">{"props":{"pageProps":{}}}</script>`)).toBeUndefined();
    expect(parseInvestingEvent(`<script id="__NEXT_DATA__">{not json</script>`)).toBeUndefined();
  });

  it("a page with an empty list is an event page with no data, not a failure", () => expect(parseInvestingEvent(page([]))).toEqual([]));
});

describe("the pages and the politeness rules", () => {
  it("names the five pages the owner gave, one series each", () => {
    expect(INVESTING_PAGES.map((p) => p.series)).toEqual(["eia_crude", "eia_gasoline", "eia_distillates", "api_crude", "eia_gas"]);
    expect(new Set(INVESTING_PAGES.map((p) => p.url)).size).toBe(5);
    expect(INVESTING_PAGES.every((p) => p.url.startsWith("https://www.investing.com/economic-calendar/"))).toBe(true);
  });

  it("reads a page at most every six hours, every thirty minutes in the ninety minutes before a release, and never while blocked", () => {
    const now = 1_800_000_000_000;
    const H = 3600_000;
    expect(shouldFetchInvesting(now, undefined, undefined)).toBe(true); // never read
    expect(shouldFetchInvesting(now, now - 2 * H, now + 20 * H)).toBe(false); // read two hours ago, release far off
    expect(shouldFetchInvesting(now, now - 7 * H, now + 20 * H)).toBe(true);
    expect(shouldFetchInvesting(now, now - 40 * 60_000, now + 60 * 60_000)).toBe(true); // release in an hour: the consensus can still move
    expect(shouldFetchInvesting(now, now - 10 * 60_000, now + 60 * 60_000)).toBe(false); // but not every ten minutes
    expect(shouldFetchInvesting(now, now - 7 * H, now + 20 * H, now + 2 * H)).toBe(false); // blocked
    expect(shouldFetchInvesting(now, now - 7 * H, now + 20 * H, now - 1)).toBe(true); // the block is over
    expect(INVESTING_BLOCK_MS).toBeGreaterThanOrEqual(6 * H);
  });

  it("recognises a block, an error and a bot check, and lets a normal page through", () => {
    expect(investingProblem(403, "")).toContain("blocking automated requests");
    expect(investingProblem(429, "")).toContain("blocking");
    expect(investingProblem(500, "")).toContain("HTTP 500");
    expect(investingProblem(200, "<title>Just a moment...</title>")).toContain("bot check");
    expect(investingProblem(200, '<html><script id="__NEXT_DATA__">{}</script></html>')).toBeUndefined();
  });
});
