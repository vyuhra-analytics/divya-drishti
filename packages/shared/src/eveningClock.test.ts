import { describe, expect, it } from "bun:test";
import { eveningEvents, inText } from "./eveningClock";

const utc = (iso: string) => Date.parse(iso);

describe("eveningEvents", () => {
  const now = utc("2026-10-27T12:00:00Z"); // 17:30 IST on a Tuesday; the US open is 13:30 UTC = 19:00 IST

  it("lists the USIB moments around the US open in order, and nothing that has passed", () => {
    const e = eveningEvents(now);
    expect(e.map((x) => x.label).slice(0, 4)).toEqual(["USIB range hour starts", "US open: the USIB range is set", "USIB entry window closes", "USIB time stop window opens"]);
    expect(e[0].at).toBe(utc("2026-10-27T12:30:00Z")); // 18:00 IST
    expect(e[1].at).toBe(utc("2026-10-27T13:30:00Z"));
    expect(eveningEvents(utc("2026-10-27T13:00:00Z"))[0].label).toBe("US open: the USIB range is set"); // the range hour has started
  });

  it("adds the EIA print and its marks, and the MCX close, merged in time order", () => {
    const printAt = utc("2026-10-28T14:30:00Z");
    const e = eveningEvents(utc("2026-10-28T12:00:00Z"), { printAt, mcxCloseAt: utc("2026-10-28T18:00:00Z") });
    const labels = e.map((x) => x.label);
    expect(labels).toContain("EIA print");
    expect(labels).toContain("EIA time stop window opens");
    expect(labels).toContain("MCX closes");
    expect(e.map((x) => x.at)).toEqual([...e.map((x) => x.at)].sort((a, b) => a - b));
    expect(e.find((x) => x.label === "EIA entry window closes")!.at).toBe(printAt + 30 * 60_000);
  });

  it("on an EIA report day the USIB marks are left out: the report is the day's trade", () => {
    const e = eveningEvents(utc("2026-10-28T12:00:00Z"), { printAt: utc("2026-10-28T14:30:00Z") });
    expect(e.some((x) => x.label.startsWith("USIB"))).toBe(false);
    expect(e[0].label).toBe("EIA range hour starts");
    expect(eveningEvents(utc("2026-10-28T12:00:00Z")).some((x) => x.label.startsWith("USIB"))).toBe(true); // no print known: USIB as usual
  });

  it("only the next day's worth, and the next evening after tonight's open has gone by", () => {
    expect(eveningEvents(now, {}, 1).every((x) => x.at <= now + 3600_000)).toBe(true);
    const late = eveningEvents(utc("2026-10-27T21:00:00Z")); // 7.5 hours after the open: tomorrow's evening is next
    expect(late[0].at).toBe(utc("2026-10-28T12:30:00Z"));
  });
});

describe("inText", () => {
  it("minutes, hours and a last-minute count", () => {
    expect(inText(23 * 60_000)).toBe("in 23m");
    expect(inText(65 * 60_000)).toBe("in 1h 05m");
    expect(inText(42_000)).toBe("in 0:42");
    expect(inText(-5)).toBe("in 0:00");
  });
});
