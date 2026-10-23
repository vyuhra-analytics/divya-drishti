import { describe, expect, it, test } from "bun:test";
import { decorateEvents, energyReleases, fillEiaPrevious, formatEiaChange, mcxHolidays, mergeForexFactory, nyTime, weekEndingTag, type CalEvent } from "./calendar";

const iso = (ms: number) => new Date(ms).toISOString();

test("nyTime follows daylight saving", () => {
  expect(iso(nyTime(2026, 9, 21, 10, 30))).toBe("2026-10-21T14:30:00.000Z"); // EDT
  expect(iso(nyTime(2026, 10, 25, 10, 30))).toBe("2026-11-25T15:30:00.000Z"); // EST
});

test("energyReleases lists the week in order, with the right US times", () => {
  const from = Date.UTC(2026, 9, 19); // Mon 19 Oct 2026
  const ev = energyReleases(from, from + 7 * 86_400_000);
  expect(ev.map((e) => e.title)).toEqual(["API crude inventories", "EIA crude inventories", "EIA natural gas storage", "Baker Hughes rig count"]);
  expect(ev.map((e) => iso(e.at))).toEqual(["2026-10-20T20:30:00.000Z", "2026-10-21T14:30:00.000Z", "2026-10-22T14:30:00.000Z", "2026-10-23T17:00:00.000Z"]);
  expect(energyReleases(from, from)).toEqual([]);
});

test("mergeForexFactory borrows forecasts, honours a shifted day, adds USD high-impact and OPEC", () => {
  const from = Date.UTC(2026, 9, 19);
  const to = from + 7 * 86_400_000;
  const rows = [
    { title: "Crude Oil Inventories", country: "USD", date: "2026-10-22T10:30:00-04:00", impact: "Medium", forecast: "-1.2M", previous: "3.5M" }, // moved to Thursday
    { title: "CPI m/m", country: "USD", date: "2026-10-21T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.2%" },
    { title: "Bank Holiday", country: "GBP", date: "2026-10-21T00:00:00-04:00", impact: "High" },
    { title: "OPEC Meetings", country: "All", date: "2026-10-23T05:00:00-04:00", impact: "Low" },
  ];
  const ev = mergeForexFactory(energyReleases(from, to), rows, from, to);
  const eia = ev.find((e) => e.title === "EIA crude inventories")!;
  expect(iso(eia.at)).toBe("2026-10-22T14:30:00.000Z");
  expect(eia.forecast).toBe("-1.2M");
  expect(eia.src).toEqual({ forecast: "Forex Factory" });
  expect(ev.find((e) => e.title === "CPI m/m (US)")?.src?.forecast).toBe("Forex Factory");
  expect(ev.filter((e) => e.title === "EIA crude inventories")).toHaveLength(1);
  expect(ev.find((e) => e.title === "CPI m/m (US)")).toMatchObject({ kind: "macro", impact: "high", forecast: "0.3%" });
  expect(ev.find((e) => e.title === "OPEC Meetings")?.kind).toBe("energy");
  expect(ev.some((e) => e.title.includes("Bank Holiday"))).toBe(false);
  expect(ev.map((e) => e.at)).toEqual([...ev.map((e) => e.at)].sort((a, b) => a - b));
});

test("mcxHolidays keeps only days MCX is closed", () => {
  const rows = [
    { date: "2026-11-08", description: "Diwali Laxmi Pujan", closed_exchanges: ["NSE", "MCX"] },
    { date: "2026-11-10", description: "Other", closed_exchanges: ["NSE"] },
  ];
  const ev = mcxHolidays(rows, Date.UTC(2026, 9, 20), Date.UTC(2026, 11, 20));
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ title: "MCX closed: Diwali Laxmi Pujan", kind: "holiday" });
  expect(iso(ev[0].at)).toBe("2026-11-07T18:30:00.000Z");
});

test("weekEndingTag names the Friday a weekly report covers", () => {
  expect(weekEndingTag(nyTime(2026, 9, 21, 10, 30))).toBe("OCT/16"); // Wednesday 21 Oct
  expect(weekEndingTag(nyTime(2026, 9, 22, 10, 30))).toBe("OCT/16"); // Thursday gas report
  expect(weekEndingTag(nyTime(2026, 9, 20, 16, 30))).toBe("OCT/16"); // Tuesday API
  expect(weekEndingTag(nyTime(2026, 10, 4, 10, 30))).toBe("OCT/30"); // Wednesday 4 Nov covers the Friday in October
});

test("decorateEvents adds market codes and the period of the weekly reports", () => {
  const from = Date.UTC(2026, 9, 19);
  const ev = decorateEvents([
    ...energyReleases(from, from + 7 * 86_400_000),
    ...mcxHolidays([{ date: "2026-11-08", description: "Diwali", closed_exchanges: ["MCX"] }], from, from + 60 * 86_400_000),
    { id: "ff-EUR-1-ECB", title: "ECB", at: 1, kind: "macro", impact: "high" },
  ]);
  const by = (t: string) => ev.find((e) => e.title.startsWith(t))!;
  expect(by("EIA crude")).toMatchObject({ country: "US", period: "OCT/16" });
  expect(by("Baker Hughes")).toMatchObject({ country: "US" });
  expect(by("Baker Hughes").period).toBeUndefined();
  expect(by("MCX closed")).toMatchObject({ country: "IN" });
  expect(by("ECB").country).toBe("EA");
});


describe("previous figures of the EIA reports from our own record", () => {
  const wed = Date.UTC(2026, 9, 28, 14, 30);
  const ev = (id: string, o: Partial<CalEvent> = {}): CalEvent => ({ id, title: "x", at: wed, kind: "energy", impact: "high", ...o });

  it("formats like the feed: crude in million barrels with a decimal, gas in Bcf", () => {
    expect(formatEiaChange("WPSR", -3.061)).toBe("-3.1M");
    expect(formatEiaChange("WPSR", 3.74)).toBe("3.7M");
    expect(formatEiaChange("WNGSR", 77.2)).toBe("77B");
    expect(formatEiaChange("WNGSR", -5)).toBe("-5B");
  });

  it("fills only the two EIA reports that have no previous, asking for the week before that release, and says where it came from", async () => {
    const asked: string[] = [];
    const out = await fillEiaPrevious([ev("eia-oil-1"), ev("eia-gas-2"), ev("api-3"), ev("eia-oil-4", { previous: "2M" })], async (r, week) => {
      asked.push(`${r} ${week}`);
      return r === "WPSR" ? -3.061 : 77;
    });
    expect(asked).toEqual(["WPSR 2026-10-16", "WNGSR 2026-10-16"]); // the Wednesday 28 Oct release covers the week ending 23 Oct; its previous report covered 16 Oct
    expect(out.map((e) => e.previous)).toEqual(["-3.1M", "77B", undefined, "2M"]);
    expect(out[0].src?.previous).toBe("our stored EIA report");
  });

  it("keeps the event as it was when nothing is stored", async () => {
    const e = ev("eia-oil-1", { src: { forecast: "Forex Factory" } });
    expect(await fillEiaPrevious([e], async () => undefined)).toEqual([e]);
  });
});
