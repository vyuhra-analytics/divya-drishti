import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EiaReport, EiaReportCode } from "@drishti/shared";
import { EiaReportWatcher, type WatchStore } from "./eia-report.service";

const rec = (id: string): { url: string; text: string }[] => JSON.parse(readFileSync(join(import.meta.dir, `../../../packages/shared/fixtures/${id}.json`), "utf8"));
const files = new Map<string, string>();
for (const r of rec("eia-wpsr-tables")) files.set(r.url, r.text);
files.set("https://ir.eia.gov/ngs/wngsr.csv", rec("eia-wngsr-csv")[0].text);

const wed = Date.UTC(2026, 9, 21, 14, 30); // the release of the recorded week (16 Oct), Wed 21 Oct 10:30 New York

function fake(events: { id: number; report: EiaReportCode; key: string; at: number; rows?: number }[] = []) {
  const saved: { eventId: number; report: EiaReport; officialAt: number; storedAt: number }[] = [];
  const store: WatchStore = {
    nextUnstored: async (report, now) => events.filter((e) => e.report === report && !e.rows && e.at > now - 3 * 86_400_000).sort((a, b) => a.at - b.at).map((e) => ({ id: e.id, key: e.key, at: e.at }))[0],
    eventFor: async (report, periodEnd, releaseAt) => {
      const key = new Date(periodEnd).toISOString().slice(0, 10);
      let e = events.find((x) => x.report === report && x.key === key);
      if (!e) events.push((e = { id: events.length + 1, report, key, at: releaseAt }));
      return { id: e.id, scheduledAt: e.at, hasRows: !!e.rows };
    },
    saveReport: async (eventId, report, officialAt, storedAt) => {
      saved.push({ eventId, report, officialAt, storedAt });
      events.find((e) => e.id === eventId)!.rows = report.rows.length;
      return report.rows.length;
    },
  };
  return { store, saved, events };
}

function watcher(f: ReturnType<typeof fake>, now: () => number, override: Record<string, string | undefined> = {}) {
  const requested: string[] = [];
  const logs: string[] = [];
  const w = new EiaReportWatcher(f.store, {
    text: async (url) => {
      requested.push(url);
      return url in override ? override[url] : files.get(url);
    },
    now,
    log: (l) => logs.push(l),
  });
  return { w, requested, logs };
}

describe("the EIA report watcher", () => {
  it("stores the whole petroleum report and the gas report at start-up when the week is not stored, and a missed release gets its event", async () => {
    const f = fake();
    const { w, logs } = watcher(f, () => wed + 3_600_000);
    const r = await w.tick();
    expect(f.saved.map((s) => s.report.report).sort()).toEqual(["WNGSR", "WPSR"]);
    expect(f.saved.find((s) => s.report.report === "WPSR")!.report.rows.length).toBeGreaterThan(150);
    expect(r.stored).toBeGreaterThan(150);
    expect(logs.join("\n")).toMatch(/WPSR: week 2026-10-16/);
  });

  it("measures the delay from the official release: the file's own time for gas, the schedule for petroleum", async () => {
    const f = fake();
    const t = wed + 4_000;
    await watcher(f, () => t).w.tick();
    expect(f.saved.find((s) => s.report.report === "WPSR")!.officialAt).toBe(wed);
    expect(f.saved.find((s) => s.report.report === "WNGSR")!.officialAt).toBe(f.saved.find((s) => s.report.report === "WNGSR")!.report.releasedAt!);
  });

  it("a week already stored is not stored again, and polling costs one small file, not nine", async () => {
    const f = fake();
    const { w, requested } = watcher(f, () => wed + 60_000);
    await w.tick();
    const before = f.saved.length;
    requested.length = 0;
    await w.tick();
    await w.tick();
    expect(f.saved.length).toBe(before);
    expect(requested.filter((u) => u.includes("/wpsr/")).length).toBe(0); // nothing is due: no fetch at all
  });

  it("while a release is due, polls only table 1 until a newer week appears, then fetches the rest", async () => {
    const next = Date.UTC(2026, 9, 28, 14, 30);
    const f = fake([{ id: 1, report: "WPSR", key: "2026-10-16", at: wed, rows: 884 }, { id: 2, report: "WPSR", key: "2026-10-23", at: next }]);
    let t = next - 30_000; // inside the lead
    const { w, requested } = watcher(f, () => t);
    await w.tick(); // start-up look stores the recorded week 16 Oct against its event (has rows) -> nothing new
    requested.length = 0;
    const r = await w.tick(); // still the old week in the files
    expect(f.saved.filter((s) => s.report.report === "WPSR")).toHaveLength(0);
    expect(requested.filter((u) => u.includes("/wpsr/"))).toEqual(["https://ir.eia.gov/wpsr/table1.csv"]);
    expect(r.delay).toBe(3000); // fast polling around the release
    t += 1000;
  });

  it("tables of two weeks (a release in progress) are not stored; the next poll tries again", async () => {
    const f = fake();
    const mixed = files.get("https://ir.eia.gov/wpsr/table4.csv")!.replace(/10\/16\/26/g, "10/23/26");
    const { w } = watcher(f, () => wed + 5_000, { "https://ir.eia.gov/wpsr/table4.csv": mixed });
    await w.tick();
    expect(f.saved.filter((s) => s.report.report === "WPSR")).toHaveLength(0);
    expect(f.saved.filter((s) => s.report.report === "WNGSR")).toHaveLength(1);
  });

  it("an unreachable file is not an error and stores nothing", async () => {
    const f = fake();
    const { w } = watcher(f, () => wed, Object.fromEntries([...files.keys()].map((k) => [k, undefined])));
    expect((await w.tick()).stored).toBe(0);
  });
});
