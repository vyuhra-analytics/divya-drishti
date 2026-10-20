import { expect, test } from "bun:test";
import { newsStamp } from "./NewsWidget";

test("newsStamp shows exact date, 24h time and zone", () => {
  const t = Date.UTC(2026, 9, 20, 17, 12); // 22:42 IST
  expect(newsStamp(t, "en-IN", "Asia/Kolkata")).toBe("20 Oct 2026, 22:42 IST");
  expect(newsStamp(t, "en-US", "America/New_York")).toBe("Oct 20, 2026, 13:12 EDT");
});
