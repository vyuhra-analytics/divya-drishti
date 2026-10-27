import { describe, expect, it } from "bun:test";
import { ForecastService, type ForecastIO } from "./forecast.service";

// The Investing.com forecast service over a fake database and a fake network: which pages it reads and when, that a block stops it, what it stores,
// and how a forecast is matched to a release. Nothing here touches the real site.
const page = (rows: object[]) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { economicCalendarEventStore: { occurrences: rows } } } } })}</script>`;
const occ = (id: number, time: string, over: object = {}) => ({ occurrence_id: id, occurrence_time: time, forecast: -0.1, previous: -8.5, unit: "M", ...over });

function setup(opts: { respond?: (url: string) => { status: number; text: string }; lastFetched?: Date | null; next?: Date | null; around?: object[] } = {}) {
  const queries: { text: string; values: unknown[] }[] = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      queries.push({ text, values });
      if (text.includes("max(fetched_at) AS t")) return Promise.resolve([{ t: opts.lastFetched ?? null }]);
      if (text.includes("min(release_at) AS t")) return Promise.resolve([{ t: opts.next ?? null }]);
      if (text.includes("abs(extract(epoch FROM release_at)")) return Promise.resolve(opts.around ?? []);
      return Promise.resolve([]);
    },
    {},
  );
  const svc = new ForecastService({ sql } as never);
  const requests: string[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let clock = Date.parse("2026-10-27T09:00:00Z");
  const io: ForecastIO = {
    get: async (url) => (requests.push(url), opts.respond ? opts.respond(url) : { status: 200, text: page([occ(1, "2026-10-21T14:30:00Z", { actual: -3.06 }), occ(2, "2026-10-28T14:30:00Z", { forecast: -0.3 })]) }),
    now: () => clock,
    sleep: async (ms) => void sleeps.push(ms),
    log: (l) => logs.push(l),
  };
  svc.io = io;
  return { svc, queries, requests, sleeps, logs, advance: (ms: number) => (clock += ms) };
}

describe("ForecastService.tick", () => {
  it("reads all four pages when none was ever read, four seconds apart, and stores what they hold", async () => {
    const { svc, requests, sleeps, queries } = setup();
    const read = await svc.tick();
    expect(read).toEqual(["eia_crude", "eia_gasoline", "eia_distillates", "api_crude"]);
    expect(requests).toHaveLength(4);
    expect(requests[0]).toContain("eia-crude-oil-inventories-75");
    expect(sleeps).toEqual([4000, 4000, 4000]); // a pause between pages, none before the first
    const insert = queries.find((q) => q.text.includes("INSERT INTO release_forecasts"))!;
    const payload = JSON.parse(String(insert.values.find((v) => typeof v === "string" && String(v).startsWith("["))));
    expect(payload).toEqual([
      { series: "eia_crude", release_at: "2026-10-21T14:30:00.000Z", occurrence_id: 1, forecast: -0.1, previous: -8.5, actual: -3.06, unit: "M" },
      { series: "eia_crude", release_at: "2026-10-28T14:30:00.000Z", occurrence_id: 2, forecast: -0.3, previous: -8.5, actual: null, unit: "M" },
    ]);
  });

  it("does not read a page again within six hours, and reads it again after", async () => {
    const { svc, requests, advance } = setup();
    await svc.tick();
    advance(2 * 3600_000);
    expect(await svc.tick()).toEqual([]);
    advance(5 * 3600_000);
    expect((await svc.tick()).length).toBe(4);
    expect(requests).toHaveLength(8);
  });

  it("carries on from the database after a restart: a page read an hour ago is left alone", async () => {
    const { svc, requests } = setup({ lastFetched: new Date("2026-10-27T08:00:00Z") });
    expect(await svc.tick()).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("looks more often in the ninety minutes before a release", async () => {
    const { svc, requests } = setup({ lastFetched: new Date("2026-10-27T08:15:00Z"), next: new Date("2026-10-27T10:00:00Z") }); // read 45 min ago, release in an hour
    expect((await svc.tick()).length).toBe(4);
    expect(requests).toHaveLength(4);
  });

  it("stops everything on the first block, says so, and leaves the site alone for twelve hours", async () => {
    const { svc, requests, advance, logs } = setup({ respond: () => ({ status: 403, text: "" }) });
    expect(await svc.tick()).toEqual([]);
    expect(requests).toHaveLength(1); // the other three pages were not even tried
    expect(logs[0]).toContain("paused for 12 h");
    advance(3600_000);
    expect(await svc.tick()).toEqual([]);
    expect(requests).toHaveLength(1);
    const st = await svc.status();
    expect(st.lastError).toContain("blocking automated requests");
    expect(st.blockedUntil).not.toBeNull();
    advance(12 * 3600_000);
    expect((await svc.tick()).length).toBe(0); // the block is over: it asks again (and is blocked again by this fake)
    expect(requests).toHaveLength(2);
  });

  it("treats a bot check page and a changed layout the same way as a block", async () => {
    const a = setup({ respond: () => ({ status: 200, text: "<title>Just a moment...</title>" }) });
    await a.svc.tick();
    expect((await a.svc.status()).lastError).toContain("bot check");
    const b = setup({ respond: () => ({ status: 200, text: "<html>an ordinary page with no data</html>" }) });
    await b.svc.tick();
    expect((await b.svc.status()).lastError).toContain("layout changed");
    expect(b.requests).toHaveLength(1);
  });

  it("is off with INVESTING_FORECASTS=off", () => {
    const { svc } = setup();
    process.env.INVESTING_FORECASTS = "off";
    expect(svc.enabled()).toBe(false);
    delete process.env.INVESTING_FORECASTS;
    expect(svc.enabled()).toBe(true);
  });
});

describe("matching a forecast to a release", () => {
  const releaseAt = Date.parse("2026-10-21T14:30:00Z");

  it("gives the crude forecast of the release, labelled as Investing.com's consensus", async () => {
    const { svc } = setup({ around: [{ series: "eia_crude", release_at: releaseAt, forecast: -0.1, previous: -8.5, actual: -3.06 }] });
    expect(await svc.crudeFor(releaseAt)).toEqual({ value: -0.1, source: "Investing.com consensus" });
  });

  it("has no forecast when the page had none for that release", async () => {
    expect(await setup({ around: [{ series: "eia_crude", release_at: releaseAt, forecast: null, previous: null, actual: null }] }).svc.crudeFor(releaseAt)).toBeUndefined();
    expect(await setup().svc.crudeFor(releaseAt)).toBeUndefined();
  });
});

describe("ForecastService.table", () => {
  const WED = (n: number) => Date.UTC(2026, 9, 7, 14, 30) + n * 7 * 86_400_000;
  const make = (forecastRows: object[], changes: object[]) => {
    const sql = Object.assign(
      (strings: TemplateStringsArray) => {
        const text = strings.join("?");
        if (text.includes("FROM release_forecasts WHERE release_at >=")) return Promise.resolve(forecastRows);
        if (text.includes("FROM eia_report_arrivals a JOIN eia_report_values v")) return Promise.resolve(changes);
        return Promise.resolve([]);
      },
      {},
    );
    const svc = new ForecastService({ sql } as never);
    svc.io = { ...svc.io, now: () => WED(2) + 2 * 86_400_000 };
    return svc;
  };

  it("lays the forecasts against the published changes, with the surprise and the rule's figures", async () => {
    const svc = make(
      [
        { series: "eia_crude", release_at: WED(1), forecast: 0.2, actual: -8.557 },
        { series: "eia_crude", release_at: WED(2), forecast: -0.1, actual: -3.06 },
        { series: "eia_crude", release_at: WED(3), forecast: -0.3, actual: null },
      ],
      [{ at: WED(2), series_id: "WPSR:T1:COMMERCIAL_EXCLUDING_SPR", change: -3.061 }, { at: WED(2), series_id: "WPSR:T1:TOTAL_MOTOR_GASOLINE", change: null }],
    );
    const t = await svc.table(52);
    expect(t.releases.map((r) => [r.upcoming, r.crude.forecast, r.crude.actual, r.crude.actualFrom])).toEqual([
      [true, -0.3, undefined, undefined],
      [false, -0.1, -3.06, "published"],
      [false, 0.2, -8.56, "investing"], // no stored report for that week: the page's own figure
    ]);
    expect(t.rule).toEqual({ threshold: 3, of: 2, reached: 1, long: 1, short: 0 });
    expect(t.threshold).toBe(3);
  });

  it("is empty when nothing is stored, and a failing database is empty rather than an error", async () => {
    expect((await make([], []).table(52)).releases).toEqual([]);
    const broken = new ForecastService({ sql: Object.assign(() => Promise.reject(new Error("db down")), {}) } as never);
    expect((await broken.table(52)).releases).toEqual([]);
  });
});

