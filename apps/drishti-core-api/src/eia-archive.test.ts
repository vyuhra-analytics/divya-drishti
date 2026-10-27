import { describe, expect, it } from "bun:test";
import type { EiaReport } from "@drishti/shared";
import { backfillArchive, type ArchiveDeps } from "./eia-archive.backfill";

// The archive backfill over fake files and a fake store: newest first, a stored week costs one request, a failing release is reported and the rest
// carry on, a dry run stores nothing. The real files are exercised by `bun run eia:archive -- --dry` and by parsing archived releases in the shared tests.
const INDEX = ["2026_10_21", "2026_10_15", "2026_10_07", "2026_09_30"].map((d) => `<a href="/petroleum/supply/weekly/archive/${d.slice(0, 4)}/${d}/wpsr_${d}.php">x</a>`).join("\n");

/** a table-1 CSV in the archive's layout, for the week ending `end` (m/d/yy), with one stock row */
const table1 = (end: string, level: number) =>
  `"STUB_1","${end}","9/25/26","Difference","Percent Change","${end.replace(/\d+$/, "25")}","Difference","Percent Change"\n"Crude Oil","${level}","${level + 1}","-1","-0.1","${level + 5}","-5","-1.0"\n`;
const WEEK_OF: Record<string, string> = { "2026_10_21": "10/16/26", "2026_10_15": "10/9/26", "2026_10_07": "10/2/26", "2026_09_30": "9/25/26" };

function setup(opts: { stored?: string[]; missing?: string[]; brokenTables?: string[] } = {}) {
  const requests: string[] = [];
  const saved: { week: number; officialAt: number }[] = [];
  const stored = new Set(opts.stored ?? []);
  const deps: ArchiveDeps = {
    index: async () => INDEX,
    csv: async (url) => {
      requests.push(url);
      const folder = /archive\/\d{4}\/([^/]+)\/csv\/table(\d)\.csv/.exec(url)!;
      if (opts.missing?.includes(folder[1])) return undefined;
      if (folder[2] === "1") return table1(WEEK_OF[folder[1]], 400);
      return opts.brokenTables?.includes(folder[1]) ? undefined : table1(WEEK_OF[folder[1]], 400); // later tables are parsed by the real parser: see below
    },
    store: {
      hasWeek: async (_r, key) => stored.has(key),
      eventFor: async () => ({ id: 1 }),
      saveReport: async (_id: number, rep: EiaReport, officialAt: number) => (saved.push({ week: rep.periodEnd, officialAt }), rep.rows.length),
    },
    now: () => 1_800_000_000_000,
    sleep: async () => undefined,
    log: () => undefined,
  };
  return { deps, requests, saved };
}

describe("backfillArchive", () => {
  it("looks at the newest releases first and no more than asked for", async () => {
    const { deps, requests } = setup();
    const s = await backfillArchive(deps, { releases: 2, dry: true });
    expect(s.considered).toBe(2);
    expect(requests[0]).toContain("/2026_10_21/csv/table1.csv");
    expect(requests.some((u) => u.includes("2026_10_07"))).toBe(false);
  });

  it("skips a release whose week is already stored after a single request", async () => {
    const { deps, requests } = setup({ stored: ["2026-10-16"] });
    const s = await backfillArchive(deps, { releases: 1, dry: true });
    expect(s).toMatchObject({ considered: 1, alreadyStored: 1, stored: 0 });
    expect(requests).toHaveLength(1);
  });

  it("reports a release the archive does not have and carries on with the rest", async () => {
    const { deps } = setup({ missing: ["2026_10_15"] });
    const s = await backfillArchive(deps, { releases: 3, dry: true });
    expect(s.failed).toEqual(["2026_10_15: table 1 not available"]);
    expect(s.considered).toBe(3);
  });

  it("stops after five releases in a row cannot be read, instead of hammering the site", async () => {
    const files = Array.from({ length: 8 }, (_, i) => `2026_0${(i % 9) + 1}_01`);
    const requests: string[] = [];
    const s = await backfillArchive(
      {
        ...setup().deps,
        index: async () => files.map((d) => `<a href="/petroleum/supply/weekly/archive/2026/${d}/wpsr_${d}.php">x</a>`).join(""),
        csv: async (u) => (requests.push(u), undefined),
      },
      { releases: 8 },
    );
    expect(s.failed).toHaveLength(5);
    expect(requests).toHaveLength(5);
  });

  it("only releases on or after the --from day", async () => {
    const { deps } = setup();
    const s = await backfillArchive(deps, { releases: 10, from: "2026-10-10", dry: true });
    expect(s.considered).toBe(2); // 2026-10-21 and 2026-10-15
  });

  it("fails when the index lists nothing, because the page has probably changed", async () => {
    const { deps } = setup();
    await expect(backfillArchive({ ...deps, index: async () => "<html></html>" })).rejects.toThrow(/listed no releases/);
  });
});
