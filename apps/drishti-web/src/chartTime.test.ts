import { expect, test } from "bun:test";
import { fromChartTime, toChartTime } from "./chartTime";

const at = (tz: string, fn: () => void) => {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    process.env.TZ = prev;
  }
};

test("chart time is local wall clock, so day ticks fall on local midnight; round-trips back", () => {
  at("Asia/Kolkata", () => {
    const midnightIst = Date.UTC(2026, 9, 20, 18, 30) / 1000; // 21 Oct 00:00 IST
    expect(toChartTime(midnightIst)).toBe(Date.UTC(2026, 9, 21) / 1000);
    expect(fromChartTime(toChartTime(midnightIst))).toBe(midnightIst);
  });
  at("America/New_York", () => {
    const midnightEdt = Date.UTC(2026, 9, 21, 4) / 1000; // 21 Oct 00:00 EDT
    expect(toChartTime(midnightEdt)).toBe(Date.UTC(2026, 9, 21) / 1000);
    const winter = Date.UTC(2026, 11, 21, 5) / 1000; // 21 Dec 00:00 EST
    expect(toChartTime(winter)).toBe(Date.UTC(2026, 11, 21) / 1000);
    expect(fromChartTime(toChartTime(winter))).toBe(winter);
  });
});
