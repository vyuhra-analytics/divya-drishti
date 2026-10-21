import { expect, test } from "bun:test";
import { energyReleases, mcxHolidays, mergeForexFactory, nyTime } from "./calendar";

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
