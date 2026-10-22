import { expect, test } from "bun:test";
import { freshness, knownStatus, mcxCloseMinutes, mcxSession, nymexSession, STATUS_MAX_AGE_MS, withStatus } from "./sessions";

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

test("spot FX: open Sunday 17:00 to Friday 17:00 New York time, round the clock in between", async () => {
  const { fxSession } = await import("./sessions");
  const at = (iso: string) => fxSession(Date.parse(iso)).open;
  expect(at("2026-10-21T03:00:00Z")).toBe(true); // Wednesday night: no daily break
  expect(at("2026-10-21T21:30:00Z")).toBe(true); // Wednesday 17:30 New York (EDT)
  expect(at("2026-10-23T20:59:00Z")).toBe(true); // Friday 16:59
  expect(at("2026-10-23T21:01:00Z")).toBe(false); // Friday 17:01
  expect(at("2026-10-24T15:00:00Z")).toBe(false); // Saturday
  expect(at("2026-10-25T20:59:00Z")).toBe(false); // Sunday 16:59
  expect(at("2026-10-25T21:01:00Z")).toBe(true); // Sunday 17:01
});

test("withStatus: the exchange's own fresh status corrects the rules in both directions; old, missing or unknown ones change nothing", () => {
  const now = ist("2026-10-21T20:00:00");
  const rulesOpen = mcxSession(now); // the rules say open (Wednesday evening)
  expect(rulesOpen.open).toBe(true);
  // a halt or early close the rules cannot see: Upstox says closed
  expect(withStatus(rulesOpen, { state: "NORMAL_CLOSE", at: now - 10_000 }, now)).toEqual({ ...rulesOpen, open: false });
  // a special session the calendar missed: the rules say closed, Upstox says open
  const rulesClosed = mcxSession(ist("2026-10-24T12:00:00")); // Saturday
  expect(withStatus(rulesClosed, { state: "NORMAL_OPEN", at: ist("2026-10-24T12:00:00") - 5_000 }, ist("2026-10-24T12:00:00")).open).toBe(true);
  // agreeing statuses change nothing (same object, no churn)
  expect(withStatus(rulesOpen, { state: "NORMAL_OPEN", at: now }, now)).toBe(rulesOpen);
  expect(withStatus(rulesClosed, { state: "NORMAL_CLOSE", at: ist("2026-10-24T12:00:00") }, ist("2026-10-24T12:00:00"))).toBe(rulesClosed);
  // old, missing, unknown or from the future: no opinion, the rules decide
  expect(withStatus(rulesOpen, { state: "NORMAL_CLOSE", at: now - STATUS_MAX_AGE_MS - 1 }, now)).toBe(rulesOpen);
  expect(withStatus(rulesOpen, undefined, now)).toBe(rulesOpen);
  expect(withStatus(rulesOpen, null, now)).toBe(rulesOpen);
  expect(withStatus(rulesOpen, { state: "PRE_OPEN_START", at: now }, now)).toBe(rulesOpen); // never read as closed
  expect(withStatus(rulesOpen, { state: "NORMAL_CLOSE", at: now + STATUS_MAX_AGE_MS + 1 }, now)).toBe(rulesOpen);
  expect(knownStatus("NORMAL_OPEN") && knownStatus("NORMAL_CLOSE")).toBe(true);
  expect(knownStatus("PRE_OPEN_START")).toBe(false);
});
