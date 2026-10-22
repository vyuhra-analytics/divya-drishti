import { describe, expect, it } from "bun:test";
import { energyReleases, type CalEvent } from "./calendar";
import { SERIES, type EventSeriesDef } from "./eventSeries";
import { planEvent, recordPlanned, weekEndingIso, type EventStore, type ObservationIn, type PlannedEvent, type StoredEventRef } from "./eventPlan";

const HOUR = 3_600_000;
const wed = Date.UTC(2026, 9, 21, 14, 30); // Wed 21 Oct 2026 10:30 New York (EDT)

const ev = (o: Partial<CalEvent> = {}): CalEvent => ({ id: "eia-oil-2026-10-21", title: "EIA crude inventories", at: wed, kind: "energy", impact: "high", ...o });

function fake() {
  const events: (StoredEventRef & { obs: ObservationIn[] })[] = [];
  const store: EventStore = {
    upsertSeries: async () => {},
    stored: async () => events.map(({ obs, ...e }) => e),
    insertEvent: async (p) => (events.push({ id: events.length + 1, seriesCode: p.series.code, key: p.key, scheduledAt: p.at, status: "scheduled", obs: [] }), events.length),
    moveEvent: async (id, at) => void (events.find((e) => e.id === id)!.scheduledAt = at),
    addObservations: async (id, obs) => {
      const e = events.find((x) => x.id === id)!;
      const fresh = obs.filter((o) => !e.obs.some((x) => x.kind === o.kind && x.text === o.text && x.source === o.source));
      e.obs.push(...fresh);
      return fresh.length;
    },
    markReleased: async (id) => void (events.find((e) => e.id === id)!.status = "released"),
  };
  return { store, events };
}

describe("planEvent", () => {
  it("keys the weekly reports by the week they cover, even when the release moves", () => {
    expect(weekEndingIso(wed)).toBe("2026-10-16");
    expect(weekEndingIso(wed + 24 * HOUR)).toBe("2026-10-16"); // holiday-shifted to Thursday
    expect(planEvent(ev())!.key).toBe("2026-10-16");
  });
  it("turns forecast, previous and actual into observations", () => {
    const p = planEvent(ev({ forecast: "-1.2M", previous: "3.7M", actual: "-8.6M", src: { forecast: "Forex Factory", actual: "EIA" } }))!;
    expect(p.observations.map((o) => [o.kind, o.num, o.source])).toEqual([["forecast", -1.2, "Forex Factory"], ["previous", 3.7, "Forex Factory"], ["actual", -8.6, "EIA"]]);
  });
  it("gives a feed row its own series", () => {
    const p = planEvent({ id: "ff-USD-1-x", title: "Core CPI m/m (US)", at: wed, kind: "macro", impact: "high" })!;
    expect(p.series.code).toBe("FF:US:CORE_CPI_M_M");
  });
});

describe("recordPlanned", () => {
  const plan = (e: Partial<CalEvent> = {}): PlannedEvent[] => [planEvent(ev(e))!];
  const run = (s: ReturnType<typeof fake>, e: Partial<CalEvent>, now = wed) => recordPlanned(s.store, plan(e), wed - 7 * 24 * HOUR, wed + 56 * 24 * HOUR, now);

  it("creates once and never duplicates on a repeat", async () => {
    const s = fake();
    expect((await run(s, { forecast: "-1.2M" })).created).toBe(1);
    const again = await run(s, { forecast: "-1.2M" });
    expect(again).toEqual({ created: 0, moved: 0, observations: 0, released: 0 });
    expect(s.events).toHaveLength(1);
  });
  it("appends a changed forecast instead of replacing it", async () => {
    const s = fake();
    await run(s, { forecast: "-1.2M" });
    await run(s, { forecast: "-2.0M" });
    expect(s.events[0].obs.filter((o) => o.kind === "forecast").map((o) => o.text)).toEqual(["-1.2M", "-2.0M"]);
  });
  it("marks released the first time an actual appears, once", async () => {
    const s = fake();
    await run(s, { forecast: "-1.2M" });
    expect(s.events[0].status).toBe("scheduled");
    expect((await run(s, { forecast: "-1.2M", actual: "-8.6M" })).released).toBe(1);
    expect((await run(s, { forecast: "-1.2M", actual: "-8.6M" })).released).toBe(0);
    expect(s.events[0].status).toBe("released");
  });
  it("moves a shifted release onto its row, not a new one; a released row never moves", async () => {
    const s = fake();
    await run(s, {});
    const moved = await recordPlanned(s.store, [planEvent(ev({ at: wed + 24 * HOUR }))!], wed - 7 * 24 * HOUR, wed + 56 * 24 * HOUR, wed);
    expect(moved.moved).toBe(1);
    expect(s.events).toHaveLength(1);
    expect(s.events[0].scheduledAt).toBe(wed + 24 * HOUR);
    s.events[0].status = "released";
    const again = await recordPlanned(s.store, [planEvent(ev({ at: wed + 48 * HOUR }))!], wed - 7 * 24 * HOUR, wed + 56 * 24 * HOUR, wed);
    expect(again.moved).toBe(0);
  });
});

describe("a series added to the dictionary", () => {
  const minutes: EventSeriesDef = { code: "RBI_MPC_MINUTES", title: "RBI MPC meeting minutes", category: "central_bank", country: "IN", importance: "high", frequency: "irregular", detail: "", relevance: ["usdinr"], source: "RBI", schedule: { kind: "dates", at: [Date.UTC(2026, 11, 18, 11, 30)] } };
  it("appears in the calendar and plans to its own series, with no other change", () => {
    SERIES.push(minutes);
    try {
      const e = energyReleases(Date.UTC(2026, 11, 1), Date.UTC(2026, 11, 31)).find((x) => x.title === minutes.title)!;
      expect(e.country).toBe("IN");
      const p = planEvent(e)!;
      expect([p.series.code, p.key]).toEqual(["RBI_MPC_MINUTES", "2026-12-18"]);
    } finally {
      SERIES.pop();
    }
  });
});
