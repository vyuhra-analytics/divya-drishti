import { expect, test } from "bun:test";
import { energyReleases, nyTime, type CalEvent } from "./calendar";
import { matchStored, planEvent, planEvents, weekEndingIso } from "./eventPlan";
import { autoSeries, occurrences, parseValue, SERIES, seriesByCode, seriesByLegacyKey, slug, zonedTime, type EventSeriesDef } from "./eventSeries";

const ny = (y: number, m: number, d: number, h: number, min: number) => nyTime(y, m - 1, d, h, min);

test("the dictionary: unique codes, the four weekly US reports and the MCX holiday series, every weekly rule a real weekday and time", () => {
  expect(new Set(SERIES.map((s) => s.code)).size).toBe(SERIES.length);
  expect(SERIES.map((s) => s.code)).toEqual(["API", "WPSR", "WNGSR", "RIGS", "MCX_HOLIDAY"]);
  for (const s of SERIES) {
    expect(s.title.length).toBeGreaterThan(3);
    expect(s.relevance.length).toBeGreaterThan(0);
    if (s.schedule.kind === "weekly") {
      expect(s.schedule.weekday).toBeGreaterThanOrEqual(0);
      expect(s.schedule.weekday).toBeLessThanOrEqual(6);
      expect(s.schedule.hour).toBeLessThan(24);
    }
  }
  expect(seriesByCode("WPSR")?.legacyKey).toBe("eia-oil");
  expect(seriesByLegacyKey("eia-gas")?.code).toBe("WNGSR");
});

test("the calendar's weekly releases come from the dictionary and are unchanged: 10:30 New York on Wednesday and Thursday, across the clock change", () => {
  const evts = energyReleases(ny(2026, 10, 26, 0, 0), ny(2026, 11, 9, 0, 0));
  const oil = evts.filter((e) => e.id.startsWith("eia-oil-")).map((e) => e.at);
  expect(oil).toEqual([ny(2026, 10, 28, 10, 30), ny(2026, 11, 4, 10, 30)]); // 20:00 IST before 1 Nov, 21:00 IST after
  expect(new Date(oil[0]).getUTCHours()).toBe(14); // EDT
  expect(new Date(oil[1]).getUTCHours()).toBe(15); // EST
  expect(evts.filter((e) => e.id.startsWith("eia-gas-")).map((e) => e.at)).toEqual([ny(2026, 10, 29, 10, 30), ny(2026, 11, 5, 10, 30)]);
});

// ---- the extension points: a weekly series in another zone, and a series with an explicit date list. These are the two shapes the RBI minutes and
// India FX reserves would take; nothing in the generator is specific to the US.
const IST = "Asia/Kolkata";
const fxReserves: EventSeriesDef = { code: "IN_FX_RESERVES", title: "India FX reserves (USD)", category: "data", country: "IN", importance: "medium", frequency: "weekly", detail: "RBI weekly statistical supplement", relevance: ["usdinr"], source: "RBI", schedule: { kind: "weekly", tz: IST, weekday: 5, hour: 17, minute: 0 } };
const rbiMinutes: EventSeriesDef = {
  code: "RBI_MPC_MINUTES",
  title: "RBI MPC meeting minutes",
  category: "central_bank",
  country: "IN",
  importance: "high",
  frequency: "irregular",
  detail: "Minutes of the Monetary Policy Committee",
  relevance: ["usdinr"],
  source: "RBI",
  schedule: { kind: "dates", at: [Date.parse("2026-10-23T17:30:00+05:30"), Date.parse("2026-12-18T17:30:00+05:30"), Date.parse("2027-02-19T17:30:00+05:30")] },
};

test("a weekly series in another time zone generates its own wall-clock times (Fridays 17:00 IST), with no daylight saving to shift them", () => {
  const out = occurrences(fxReserves, Date.parse("2026-10-19T00:00:00+05:30"), Date.parse("2026-11-09T00:00:00+05:30"));
  expect(out).toEqual([Date.parse("2026-10-23T17:00:00+05:30"), Date.parse("2026-10-30T17:00:00+05:30"), Date.parse("2026-11-06T17:00:00+05:30")]);
  expect(zonedTime(IST, 2026, 9, 23, 17, 0)).toBe(Date.parse("2026-10-23T17:00:00+05:30"));
});

test("a series with an explicit date list generates exactly the listed instants inside the window, oldest first; a feed series generates none", () => {
  expect(occurrences(rbiMinutes, Date.parse("2026-10-01T00:00:00Z"), Date.parse("2027-01-01T00:00:00Z"))).toEqual([Date.parse("2026-10-23T17:30:00+05:30"), Date.parse("2026-12-18T17:30:00+05:30")]);
  expect(occurrences(rbiMinutes, Date.parse("2028-01-01T00:00:00Z"), Date.parse("2029-01-01T00:00:00Z"))).toEqual([]);
  expect(occurrences(seriesByCode("MCX_HOLIDAY")!, 0, Date.now())).toEqual([]);
});

// ---- identity of live events
test("the weekly reports' natural key is the week-ending Friday, also when a holiday shifts the release", () => {
  expect(weekEndingIso(ny(2026, 10, 21, 10, 30))).toBe("2026-10-16"); // Wednesday 21 Oct: the week ending Friday 16 Oct
  expect(weekEndingIso(ny(2026, 10, 22, 10, 30))).toBe("2026-10-16"); // the gas report on Thursday: the same week
  expect(weekEndingIso(ny(2026, 11, 26, 10, 30))).toBe("2026-11-20"); // Thanksgiving week: shifted to Wednesday, same Friday
  expect(weekEndingIso(ny(2026, 11, 27, 10, 30))).toBe("2026-11-20"); // a Friday release day: the Friday before
});

const cal = (over: Partial<CalEvent>): CalEvent => ({ id: "eia-oil-1", title: "EIA crude inventories", at: ny(2026, 10, 21, 10, 30), kind: "energy", impact: "high", ...over });

test("planEvent: a weekly report gets its series, week-ending key and every figure as an observation with its parsed number and source", () => {
  const p = planEvent(cal({ id: `eia-oil-${ny(2026, 10, 21, 10, 30)}`, forecast: "-1.2M", previous: "-3.1M", actual: "-4.6M", src: { forecast: "Forex Factory", actual: "EIA weekly report (ir.eia.gov)" } }))!;
  expect(p.series.code).toBe("WPSR");
  expect(p.key).toBe("2026-10-16");
  expect(p.period).toBe("2026-10-16");
  expect(p.observations).toEqual([
    { kind: "forecast", text: "-1.2M", num: -1.2, unit: "M", source: "Forex Factory" },
    { kind: "previous", text: "-3.1M", num: -3.1, unit: "M", source: "Forex Factory" },
    { kind: "actual", text: "-4.6M", num: -4.6, unit: "M", source: "EIA weekly report (ir.eia.gov)" },
  ]);
  expect(planEvent(cal({ id: "eia-gas-1", at: ny(2026, 10, 22, 10, 30) }))!.series.code).toBe("WNGSR");
  expect(planEvent(cal({ id: "eia-oil-1" }))!.observations).toEqual([]); // nothing known yet: an event with no figures
});

test("planEvent: the MCX holiday and the rig count keep their own keys; an unknown id is not planned", () => {
  const h = planEvent({ id: "mcx-2026-11-08", title: "MCX closed: Diwali", at: Date.parse("2026-11-08T00:00:00+05:30"), kind: "holiday", impact: "medium" })!;
  expect([h.series.code, h.key]).toEqual(["MCX_HOLIDAY", "2026-11-08"]);
  const r = planEvent({ id: "rigs-1", title: "Baker Hughes rig count", at: ny(2026, 10, 23, 13, 0), kind: "energy", impact: "medium" })!;
  expect([r.series.code, r.key]).toEqual(["RIGS", "2026-10-23"]);
  expect(planEvent({ id: "weird-1", title: "x", at: 1, kind: "macro", impact: "low" })).toBeUndefined();
});

test("planEvent: a Forex Factory row becomes its own series on first sight, categorised, and the same row always lands in the same series", () => {
  const e: CalEvent = { id: "ff-USD-1792000000000-Core CPI m/m", title: "Core CPI m/m (US)", at: Date.parse("2026-11-12T13:30:00Z"), kind: "macro", impact: "high", forecast: "0.3%", previous: "0.2%", src: { forecast: "Forex Factory" } };
  const p = planEvent(e)!;
  expect(p.series).toMatchObject({ code: "FF:US:CORE_CPI_M_M", title: "Core CPI m/m", category: "macro", country: "US", importance: "high", source: "Forex Factory" });
  expect(p.key).toBe("2026-11-12");
  expect(p.observations.map((o) => [o.kind, o.num, o.unit])).toEqual([["forecast", 0.3, "%"], ["previous", 0.2, "%"]]);
  expect(planEvent({ ...e, id: "ff-USD-1793000000000-Core CPI m/m", at: Date.parse("2026-12-11T13:30:00Z") })!.series.code).toBe("FF:US:CORE_CPI_M_M");
  const fomc = planEvent({ ...e, id: "ff-USD-1-FOMC Meeting Minutes", title: "FOMC Meeting Minutes (US)" })!;
  expect(fomc.series.category).toBe("central_bank");
  const opec = planEvent({ id: "ff-USD-1-OPEC Meetings", title: "OPEC Meetings", at: 1, kind: "energy", impact: "medium" })!;
  expect([opec.series.category, opec.series.relevance]).toEqual(["energy", ["crude", "gas"]]);
});

test("matchStored: the same series and key is the same row; a release moved by a day keeps its row; another week or another series never matches", () => {
  const wed = ny(2026, 10, 21, 10, 30);
  const stored = [
    { id: 1, seriesCode: "WPSR", key: "2026-10-16", scheduledAt: wed, status: "scheduled" },
    { id: 2, seriesCode: "WPSR", key: "2026-10-23", scheduledAt: wed + 7 * 86_400_000, status: "scheduled" },
    { id: 3, seriesCode: "WNGSR", key: "2026-10-16", scheduledAt: wed + 86_400_000, status: "scheduled" },
  ];
  const wpsr = seriesByCode("WPSR")!;
  expect(matchStored(stored, { series: wpsr, key: "2026-10-16", at: wed })?.id).toBe(1);
  expect(matchStored(stored, { series: wpsr, key: "2026-10-17", at: wed + 86_400_000 })?.id).toBe(1); // moved a day, key differs: the nearest unreleased row
  expect(matchStored([{ ...stored[0], status: "released" }], { series: wpsr, key: "2026-10-17", at: wed + 86_400_000 })).toBeUndefined(); // a released row is never moved
  expect(matchStored(stored, { series: wpsr, key: "2026-11-06", at: wed + 16 * 86_400_000 })).toBeUndefined();
  expect(matchStored(stored, { series: seriesByCode("API")!, key: "2026-10-16", at: wed })).toBeUndefined();
});

test("planEvents plans a whole calendar list and skips what belongs to no series", () => {
  const list = energyReleases(ny(2026, 10, 19, 0, 0), ny(2026, 10, 27, 0, 0));
  expect(planEvents(list)).toHaveLength(list.length);
  expect(planEvents([...list, { id: "zzz-1", title: "?", at: 1, kind: "macro", impact: "low" }])).toHaveLength(list.length);
});

test("slug and parseValue: stable codes from titles, numbers and units from published figures", () => {
  expect(slug("Core CPI m/m (US)")).toBe("CORE_CPI_M_M");
  expect(slug("  Fed Chair Powell Speaks  ")).toBe("FED_CHAIR_POWELL_SPEAKS");
  expect(autoSeries("INR", "RBI Policy Rate", "high", "central_bank")).toMatchObject({ code: "FF:IN:RBI_POLICY_RATE", country: "IN", relevance: ["usdinr", "mcx"] });
  expect(parseValue("-4.6M")).toEqual({ num: -4.6, unit: "M" });
  expect(parseValue("5.2%")).toEqual({ num: 5.2, unit: "%" });
  expect(parseValue("250K")).toEqual({ num: 250, unit: "K" });
  expect(parseValue("3,567")).toEqual({ num: 3567 });
  expect(parseValue("<0.1%")).toEqual({ num: 0.1, unit: "%" });
  expect(parseValue("-3B")).toEqual({ num: -3, unit: "B" });
  expect(parseValue("")).toEqual({});
  expect(parseValue(undefined)).toEqual({});
  expect(parseValue("n/a")).toEqual({});
});
