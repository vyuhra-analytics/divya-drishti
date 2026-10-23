import { describe, expect, it } from "bun:test";
import { arrivalDelay, inReleaseWindow, nextPollDelay, releaseAtFor, shouldFetch, weekKey, WATCH } from "./eiaWatch";

const wed = Date.UTC(2026, 9, 28, 14, 30); // Wed 28 Oct 2026 10:30 New York (EDT)

describe("nextPollDelay", () => {
  it("is idle when nothing waits or the release is too old", () => {
    expect(nextPollDelay(wed, undefined)).toBe(WATCH.idle);
    expect(nextPollDelay(wed + 4 * 86_400_000, wed)).toBe(WATCH.idle);
  });
  it("sleeps until just before the release, never longer than the idle pause", () => {
    expect(nextPollDelay(wed - 3_600_000, wed)).toBe(WATCH.idle);
    expect(nextPollDelay(wed - WATCH.lead - 60_000, wed)).toBe(60_000);
  });
  it("polls fast from the lead until ten minutes after, then once a minute", () => {
    expect(nextPollDelay(wed - 30_000, wed)).toBe(WATCH.fast);
    expect(nextPollDelay(wed + 5 * 60_000, wed)).toBe(WATCH.fast);
    expect(nextPollDelay(wed + 11 * 60_000, wed)).toBe(WATCH.late);
  });
});

describe("shouldFetch", () => {
  it("only from the lead before the release until it is given up on", () => {
    expect(shouldFetch(wed - WATCH.lead - 1, wed)).toBe(false);
    expect(shouldFetch(wed - WATCH.lead, wed)).toBe(true);
    expect(shouldFetch(wed + 2 * 86_400_000, wed)).toBe(true);
    expect(shouldFetch(wed + 4 * 86_400_000, wed)).toBe(false);
    expect(shouldFetch(wed, undefined)).toBe(false);
  });
});

describe("which release a week belongs to", () => {
  const friday = Date.UTC(2026, 9, 23);
  it("the petroleum report of the week ending Friday is the following Wednesday 10:30 New York, the gas report Thursday", () => {
    expect(new Date(releaseAtFor("WPSR", friday)!).toISOString()).toBe("2026-10-28T14:30:00.000Z");
    expect(new Date(releaseAtFor("WNGSR", friday)!).toISOString()).toBe("2026-10-29T14:30:00.000Z");
  });
  it("follows daylight saving: after the clocks change the same 10:30 is an hour later in UTC", () => {
    expect(new Date(releaseAtFor("WPSR", Date.UTC(2026, 10, 6))!).toISOString()).toBe("2026-11-11T15:30:00.000Z");
  });
  it("keys a week by its ending date", () => {
    expect(weekKey(friday)).toBe("2026-10-23");
  });
});

it("an arrival before the official time counts as no delay", () => {
  expect(arrivalDelay(1000, 4200)).toBe(3200);
  expect(arrivalDelay(5000, 4000)).toBe(0);
});

it("the release window is two minutes before to fifteen after a Wednesday or Thursday 10:30 New York", () => {
  const thu = Date.UTC(2026, 9, 29, 14, 30);
  expect([inReleaseWindow(wed - 3 * 60_000), inReleaseWindow(wed - 60_000), inReleaseWindow(wed + 14 * 60_000), inReleaseWindow(wed + 16 * 60_000)]).toEqual([false, true, true, false]);
  expect([inReleaseWindow(thu), inReleaseWindow(thu + 5 * 3_600_000)]).toEqual([true, false]);
  expect(inReleaseWindow(Date.UTC(2026, 9, 27, 14, 30))).toBe(false); // a Tuesday
});
