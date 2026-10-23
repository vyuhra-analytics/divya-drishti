import { describe, expect, it } from "bun:test";
import { clExpiries, clExpiry, touchesRoll, usHolidays } from "./clExpiry";

const d = (y: number, m: number, day: number) => Date.UTC(y, m - 1, day);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("CL expiry dates (known contracts)", () => {
  it("is three business days before the 25th of the month before delivery", () => {
    expect(iso(clExpiry(2026, 11))).toBe("2026-11-20"); // Dec 2026: 25 Nov is a Wednesday
    expect(iso(clExpiry(2025, 11))).toBe("2025-11-20"); // Dec 2025
    expect(iso(clExpiry(2026, 5))).toBe("2026-05-19"); // June 2026: 25 May is Memorial Day, so back to Friday 22 May, then 3 business days
  });

  it("steps back one business day when the 25th is not one (a weekend or a holiday), then three more", () => {
    expect(iso(clExpiry(2026, 0))).toBe("2025-12-19"); // Jan 2026: 25 Dec is Christmas, 24 Dec then 3 business days back is the 19th
    expect(iso(clExpiry(2026, 6))).toBe("2026-06-22"); // July 2026: 25 June is a Thursday
  });
});

describe("holidays", () => {
  it("lists the exchange closures of a year, with weekend holidays observed on the Friday or Monday", () => {
    const h = [...usHolidays(2026)].map(iso).sort();
    expect(h).toContain("2026-01-01");
    expect(h).toContain("2026-04-03"); // Good Friday 2026 (Easter 5 April)
    expect(h).toContain("2026-07-03"); // 4 July is a Saturday: observed Friday
    expect(h).toContain("2026-11-26"); // Thanksgiving
    expect(h).toHaveLength(10);
  });
});

describe("rolls in a window", () => {
  it("lists the expiries around a period, one a month", () => {
    const e = clExpiries(d(2026, 1, 1), d(2026, 12, 31)).map(iso);
    expect(e.length).toBeGreaterThanOrEqual(12);
    expect(e).toContain("2026-11-20");
    expect([...e].sort()).toEqual(e);
  });

  it("a window touches a roll from a day before the expiry to three days after, and not outside", () => {
    const e = [d(2026, 11, 20)];
    expect(touchesRoll(d(2026, 11, 19), d(2026, 11, 19) + 3_600_000, e)).toBe(true);
    expect(touchesRoll(d(2026, 11, 22), d(2026, 11, 23), e)).toBe(true);
    expect(touchesRoll(d(2026, 11, 16), d(2026, 11, 17), e)).toBe(false);
    expect(touchesRoll(d(2026, 11, 24), d(2026, 11, 25), e)).toBe(false);
    expect(touchesRoll(d(2026, 11, 10), d(2026, 11, 21), e)).toBe(true); // a window that spans the expiry
  });
});
