import { describe, expect, it } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { FeedController } from "./feed.controller";

// The read routes over what the Upstox capture stored, with a fake database: bad input must be refused before any query, and the coverage route
// must turn feed_minutes rows into holes. The live routes are exercised by hand and by `bun run smoke`.
function controller(rows: Record<string, unknown[]> = {}) {
  const queries: string[] = [];
  const sql = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    queries.push(text);
    const hit = Object.keys(rows).find((k) => text.includes(k));
    return Promise.resolve(hit ? rows[hit] : []);
  };
  return { c: new FeedController({ sql } as never), queries };
}
const refused = async (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(BadRequestException);

describe("FeedController input", () => {
  it("refuses a bad key, an unreadable time, a window over two days, a bad limit and an unknown underlying before querying", async () => {
    const { c, queries } = controller();
    await refused(c.quotes("evil", "2026-10-26T10:00:00Z", "2026-10-26T11:00:00Z"));
    await refused(c.quotes("MCX:CRUDEOIL", "yesterday", "2026-10-26T11:00:00Z"));
    await refused(c.quotes("MCX:CRUDEOIL", "2026-10-01T00:00:00Z", "2026-10-20T00:00:00Z"));
    await refused(c.quotes("MCX:CRUDEOIL", "2026-10-26T11:00:00Z", "2026-10-26T10:00:00Z"));
    await refused(c.quotes("MCX_FO|582934", "2026-10-26T10:00:00Z", "2026-10-26T11:00:00Z", "999999"));
    await refused(c.chain("GOLD"));
    await refused(c.chain("CRUDEOIL", "17-11-2026"));
    await refused(c.coverage("today"));
    expect(queries).toEqual([]);
  });
});

describe("FeedController coverage", () => {
  it("counts the minutes with Upstox messages inside the official window and lists the holes", async () => {
    const start = Date.parse("2026-10-26T09:00:00+05:30");
    const mins = [0, 1, 2, 6, 7].map((m) => ({ t: start + m * 60_000 }));
    const { c } = controller({
      "FROM market_days": [{ start_at: new Date(start), end_at: new Date(start + 10 * 60_000) }],
      "FROM feed_minutes": mins,
    });
    const r = await c.coverage("2026-10-26");
    expect(r.window).toEqual({ from: start, to: start + 10 * 60_000, official: true });
    expect(r).toMatchObject({ expectedMinutes: 10, coveredMinutes: 5 });
    expect(r.gaps).toEqual([{ from: start + 3 * 60_000, to: start + 6 * 60_000, minutes: 3 }, { from: start + 8 * 60_000, to: start + 10 * 60_000, minutes: 2 }]);
  });

  it("judges a session that is still running only up to now", async () => {
    const now = Date.now();
    const start = Math.floor(now / 60_000) * 60_000 - 10 * 60_000;
    const day = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
    const { c } = controller({
      "FROM market_days": [{ start_at: new Date(start), end_at: new Date(start + 3 * 3600_000) }],
      "FROM feed_minutes": [{ t: start }, { t: start + 60_000 }],
    });
    const r = await c.coverage(day);
    expect(r.expectedMinutes).toBe(10); // not 180
    expect(r.coveredMinutes).toBe(2);
    expect(r.gaps).toEqual([{ from: start + 2 * 60_000, to: start + 10 * 60_000, minutes: 8 }]);
  });

  it("falls back to the 09:00 to 23:30 IST weekday window when the day has no official times, and says so", async () => {
    const r = await controller().c.coverage("2026-10-20");
    expect(r.window.official).toBe(false);
    expect(r.expectedMinutes).toBe(870);
    expect(r.coveredMinutes).toBe(0);
  });
});

describe("FeedController chain", () => {
  it("returns no contracts when nothing was snapshotted by then", async () => {
    expect(await controller({ "max(time)": [{ t: null }] }).c.chain("CRUDEOIL", undefined, "2026-01-01T00:00:00Z")).toEqual({ at: null, contracts: [] });
  });
});
