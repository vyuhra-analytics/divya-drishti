import { describe, expect, it } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { TimeProfileController } from "./time-profile.controller";
import { timeProfile } from "./time-profile";

// A fake database answered by the text of each query; sql(array) is the identity (the driver splices it into IN (...)).
const edt = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 + 4 * 3600;
function fakeSql(rows: object[], spreads: object[] = [], spreadDays = 0) {
  const asked: string[] = [];
  const fn = (strings: TemplateStringsArray | unknown[]) => {
    if (!("raw" in strings)) return strings;
    const text = strings.join("?");
    asked.push(text);
    if (text.includes("FROM option_contracts")) return Promise.resolve([{ key: "K1" }, { key: "K2" }]);
    if (text.includes("FROM option_candles")) return Promise.resolve(rows);
    if (text.includes("count(DISTINCT")) return Promise.resolve([{ n: spreadDays }]);
    if (text.includes("FROM feed_quotes")) return Promise.resolve(spreads);
    return Promise.resolve([]);
  };
  return { sql: fn as never, asked };
}
/** one-minute candles of a contract over [from, to) of a New York day */
function span(key: string, day: string, from: string, to: string, mid: number, half: number, volume: number) {
  const out: object[] = [];
  for (let t = edt(day, from); t < edt(day, to); t += 60) out.push({ key, t, open: mid, high: mid + half, low: mid - half, close: mid, volume });
  return out;
}

describe("timeProfile", () => {
  it("uses the contract that traded most each New York day, and names each window with its range and activity", async () => {
    const rows = [...span("K1", "2026-10-21", "07:00", "10:00", 100, 1, 10), ...span("K2", "2026-10-21", "07:00", "10:00", 500, 9, 1), ...span("K1", "2026-10-21", "12:00", "13:30", 100, 0.5, 10)];
    const { sql } = fakeSql(rows);
    const p = await timeProfile(sql, "CRUDEOILM", 30);
    expect(p.days).toBe(1);
    const nyam = p.windows.find((w) => w.window === "nyam")!;
    expect(nyam).toMatchObject({ label: "New York AM", killzone: true, days: 1, avgRange: 2 }); // K1's 100 +- 1, not K2's 500 +- 9
    expect(nyam.avgBarRangePct).toBeCloseTo(2, 6);
    expect(p.windows.find((w) => w.window === "lunch")!.killzone).toBe(false);
    expect(p.recent.map((z) => [z.day, z.window, z.high, z.low, z.range])).toEqual([
      ["2026-10-21", "nyam", 101, 99, 2],
      ["2026-10-21", "lunch", 100.5, 99.5, 1],
    ]);
  });

  it("puts the recorded spread on the windows it falls in, weighted by quotes, and says how many days it rests on", async () => {
    const rows = span("K1", "2026-10-21", "07:00", "10:00", 100, 1, 10);
    // half-hour buckets of New York time: 07:00 and 07:30 are in the AM window (7:00-10:00), 11:00 is outside it
    const spreads = [{ m: 420, n: 100, pct: 0.02 }, { m: 450, n: 300, pct: 0.04 }, { m: 660, n: 50, pct: 9 }];
    const p = await timeProfile(fakeSql(rows, spreads, 2).sql, "CRUDEOILM", 30);
    const nyam = p.windows.find((w) => w.window === "nyam")!;
    expect(nyam.spreadRows).toBe(400);
    expect(nyam.spreadPct).toBeCloseTo((100 * 0.02 + 300 * 0.04) / 400, 9);
    expect(p.spreadDays).toBe(2);
  });

  it("no spread without recorded quotes, and an empty profile without candles", async () => {
    const p = await timeProfile(fakeSql(span("K1", "2026-10-21", "07:00", "10:00", 100, 1, 10)).sql, "CRUDEOILM", 30);
    expect(p.windows[0].spreadPct).toBeUndefined();
    const none = await timeProfile(fakeSql([]).sql, "CRUDEOILM", 30);
    expect(none).toMatchObject({ days: 0, windows: [], recent: [] });
  });

  it("keeps only the latest days in `recent`", async () => {
    const rows = ["2026-10-19", "2026-10-20", "2026-10-21"].flatMap((d) => span("K1", d, "07:00", "10:00", 100, 1, 10));
    const p = await timeProfile(fakeSql(rows).sql, "CRUDEOILM", 30, 2);
    expect([...new Set(p.recent.map((z) => z.day))]).toEqual(["2026-10-20", "2026-10-21"]);
  });
});

describe("GET /research/time-profile", () => {
  it("refuses a bad contract, days or recent before touching the database", async () => {
    const asked = fakeSql([]);
    const c = new TimeProfileController({ sql: asked.sql } as never);
    await expect(c.profile("GOLD")).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.profile("CRUDEOILM", "2")).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.profile("CRUDEOILM", "500")).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.profile("CRUDEOILM", "abc")).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.profile("CRUDEOILM", "60", "0")).rejects.toBeInstanceOf(BadRequestException);
    expect(asked.asked).toHaveLength(0);
  });

  it("defaults to crude mini over 60 days", async () => {
    const c = new TimeProfileController({ sql: fakeSql([]).sql } as never);
    expect((await c.profile()).underlying).toBe("CRUDEOILM");
  });
});
