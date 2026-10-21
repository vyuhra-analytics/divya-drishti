import { expect, test } from "bun:test";
import { freshness, mcxCloseMinutes, mcxSession, nymexSession } from "./sessions";

const ist = (iso: string) => Date.parse(`${iso}+05:30`);
const et = (iso: string, offset = "-04:00") => Date.parse(`${iso}${offset}`);

test("MCX: weekday 09:00 to 23:30 IST while the US is on daylight time", () => {
  expect(mcxCloseMinutes(ist("2026-10-21T12:00:00"))).toBe(23 * 60 + 30);
  expect(mcxSession(ist("2026-10-21T08:59:00"))).toEqual({ open: false, next: ist("2026-10-21T09:00:00") });
  expect(mcxSession(ist("2026-10-21T09:00:00"))).toEqual({ open: true, next: ist("2026-10-21T23:30:00") });
  expect(mcxSession(ist("2026-10-21T23:31:00"))).toEqual({ open: false, next: ist("2026-10-22T09:00:00") });
});

test("MCX: closes 23:55 IST once the US is on standard time", () => {
  expect(mcxCloseMinutes(ist("2026-11-10T12:00:00"))).toBe(23 * 60 + 55);
  expect(mcxSession(ist("2026-11-10T23:45:00"))).toEqual({ open: true, next: ist("2026-11-10T23:55:00") });
});

test("MCX: weekend closed until Monday 09:00; Upstox calendar overrides holidays and special sessions", () => {
  expect(mcxSession(ist("2026-10-24T12:00:00"))).toEqual({ open: false, next: ist("2026-10-26T09:00:00") }); // Saturday
  expect(mcxSession(ist("2026-10-23T23:40:00"))).toEqual({ open: false, next: ist("2026-10-26T09:00:00") }); // Friday after close
  expect(mcxSession(ist("2026-10-21T12:00:00"), "closed").open).toBe(false); // holiday
  const special = { start: ist("2026-10-21T17:00:00"), end: ist("2026-10-21T23:55:00") };
  expect(mcxSession(ist("2026-10-21T12:00:00"), special)).toEqual({ open: false, next: special.start });
  expect(mcxSession(ist("2026-10-21T18:00:00"), special)).toEqual({ open: true, next: special.end });
});

test("NYMEX: Sunday 18:00 to Friday 17:00 ET with the daily 17:00–18:00 break", () => {
  expect(nymexSession(et("2026-10-21T10:00:00"))).toEqual({ open: true, next: et("2026-10-21T17:00:00") }); // Wed
  expect(nymexSession(et("2026-10-21T17:30:00"))).toEqual({ open: false, next: et("2026-10-21T18:00:00") });
  expect(nymexSession(et("2026-10-21T19:00:00"))).toEqual({ open: true, next: et("2026-10-22T17:00:00") });
  expect(nymexSession(et("2026-10-23T17:01:00"))).toEqual({ open: false, next: et("2026-10-25T18:00:00") }); // Fri close
  expect(nymexSession(et("2026-10-24T12:00:00"))).toEqual({ open: false, next: et("2026-10-25T18:00:00") }); // Sat
  expect(nymexSession(et("2026-10-25T17:59:00")).open).toBe(false); // Sun before open
  expect(nymexSession(et("2026-10-25T18:00:00")).open).toBe(true);
  expect(nymexSession(et("2026-12-02T10:00:00", "-05:00"))).toEqual({ open: true, next: et("2026-12-02T17:00:00", "-05:00") }); // EST
});

test("freshness: closed beats stale; live within the window", () => {
  expect(freshness(false, 1000, 2000)).toBe("closed");
  expect(freshness(true, 1000, 2000, 60_000)).toBe("live");
  expect(freshness(true, 1000, 70_000, 60_000)).toBe("stale");
  expect(freshness(true, undefined, 70_000)).toBe("stale");
});
