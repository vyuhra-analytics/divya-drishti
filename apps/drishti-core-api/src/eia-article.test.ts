import { describe, expect, it } from "bun:test";
import { BadRequestException, GoneException, NotFoundException } from "@nestjs/common";
import type { Bar, EiaReportRow, FlowRow } from "@drishti/shared";
import { EiaArticleController } from "./eia-article.controller";
import { EiaArticleService, type ArticleSources } from "./eia-article.service";
import type { StoredReport } from "./eia-report.store";

// The release article routes over a fake database and fake sources: the facts a report gives, the reaction around the official release time, what an
// agent may submit, and that the check runs against the context the agent was given. Live behaviour is checked by hand against the stored reports.
const RELEASE = Date.parse("2026-10-21T14:30:00Z");
const row = (seriesId: string, unit: string, value: number, over: Partial<EiaReportRow> = {}): EiaReportRow => ({ seriesId, report: "WPSR", table: "T1", group: "", parent: "", label: seriesId, unit, seq: 1, periodEnd: Date.UTC(2026, 9, 16), value, headline: false, ...over });
const stored = (over: Partial<StoredReport> = {}): StoredReport => ({
  eventId: 7,
  report: "WPSR",
  weekEnding: "2026-10-16",
  scheduledAt: RELEASE,
  officialReleaseAt: RELEASE,
  firstStoredAt: RELEASE + 4000,
  rows: [row("WPSR:T1:COMMERCIAL_EXCLUDING_SPR", "million barrels", 412.517, { change: -3.061, prior: 415.578, yearAgoPct: -2.4, yearAgo: 422.7, headline: true }), row("WPSR:T4:CUSHING", "million barrels", 27.594, { change: 0.987 })],
  ...over,
});

const bar = (minute: number, price: number): Bar => ({ time: RELEASE / 1000 + minute * 60, open: price, high: price + 0.2, low: price - 0.2, close: price, volume: 10 });
const quietBars = (): Bar[] => [...Array.from({ length: 40 }, (_, i) => bar(i - 40, 100)), ...Array.from({ length: 20 }, (_, i) => bar(i, 100 + i / 10))];

function setup(opts: { stored?: StoredReport | undefined; bars?: (s: string) => Bar[]; feed?: FlowRow[]; forecast?: { value: number; source: string }; writtenRow?: unknown; savedReaction?: unknown; expectations?: object; crudeConsensus?: { value: number; source: string } } = {}) {
  const inserts: unknown[][] = [];
  const savedReactions: unknown[][] = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("INSERT INTO eia_articles")) {
        inserts.push(values);
        return Promise.resolve([]);
      }
      if (text.includes("FROM eia_articles")) return Promise.resolve(opts.writtenRow ? [opts.writtenRow] : []);
      if (text.includes("INSERT INTO eia_release_reactions")) {
        savedReactions.push(values);
        return Promise.resolve([]);
      }
      if (text.includes("FROM eia_release_reactions")) return Promise.resolve(opts.savedReaction ? [opts.savedReaction] : []);
      return Promise.resolve([]);
    },
    {},
  );
  const db = { sql, redis: {} } as never;
  const reports = { store: { latest: async () => ("stored" in opts ? opts.stored : stored()), forecastFor: async () => opts.forecast } } as never;
  const history = { contexts: async () => ({}), status: async () => ({ series: [], syncing: false, lastSyncAt: null }) } as never;
  const forecasts = { crudeFor: async () => opts.crudeConsensus, expectationsFor: async () => opts.expectations ?? {} } as never;
  const service = new EiaArticleService(db, reports, history, forecasts);
  const sources: ArticleSources = { bars: async (s) => (opts.bars ? opts.bars(s) : quietBars()), feed: async () => opts.feed ?? [], contexts: async () => ({}), expectations: async () => opts.expectations ?? {} };
  service.sources = sources;
  const controller = new EiaArticleController(service, history, db);
  return { service, controller, inserts, savedReactions };
}

describe("EiaArticleService.facts", () => {
  it("gives the report's figures rounded as printed, the forecast on record, and the reaction around the official release time", async () => {
    const { service } = setup({ forecast: { value: -0.1, source: "Forex Factory" } });
    const got = (await service.facts("WPSR"))!;
    expect(got.facts.headline).toMatchObject({ level: 412.5, change: -3.06, forecast: -0.1 });
    expect(got.facts.forecast).toEqual({ value: -0.1, source: "Forex Factory" });
    expect(got.facts.storedAfterSeconds).toBe(4);
    // two instruments are asked for; both have candles in this setup
    expect(Object.keys(got.facts.reaction ?? {}).sort()).toEqual(["cl", "mcx_crude"]);
    expect(got.facts.reaction!.cl.moves.m5.pct).toBeGreaterThan(0);
    expect(got.facts.reaction!.cl.basePrice).toBe(100);
  });

  it("ranks the forecasts: typed in, then recorded for the release, then Investing.com's consensus as the last resort", async () => {
    const consensus = { value: -0.1, source: "Investing.com consensus" };
    expect((await setup({ crudeConsensus: consensus }).service.facts("WPSR"))!.facts.forecast).toEqual(consensus); // nothing else on record
    expect((await setup({ crudeConsensus: consensus, forecast: { value: 0.4, source: "Forex Factory" } }).service.facts("WPSR"))!.facts.forecast).toEqual({ value: 0.4, source: "Forex Factory" });
    expect((await setup({ crudeConsensus: consensus, forecast: { value: 0.4, source: "Forex Factory" } }).service.facts("WPSR", undefined, -4))!.facts.forecast).toEqual({ value: -4, source: "typed in" });
  });

  it("adds the product forecasts and the API's report the day before, with each surprise, and the article says them with every figure checked", async () => {
    const { service } = setup({
      stored: stored({ rows: [...stored().rows, row("WPSR:T1:TOTAL_MOTOR_GASOLINE", "million barrels", 205.31, { change: -2.952 }), row("WPSR:T1:DISTILLATE_FUEL_OIL", "million barrels", 104.286, { change: 1.674 })] }),
      expectations: { gasoline: -0.4, distillates: -1.2, api: { change: -4.93, forecast: -1.3, at: RELEASE - 18 * 3600_000 } },
    });
    const r = (await service.article("WPSR"))!;
    expect(r.facts.expect).toMatchObject({ gasoline: { forecast: -0.4, surprise: -2.55 }, distillates: { forecast: -1.2, surprise: 2.87 }, api: { change: -4.93, forecast: -1.3, surprise: -3.63 } });
    const text = r.template.article.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join("\n");
    expect(text).toContain("The API reported a draw of 4.93 million barrels the day before, against a forecast of −1.30; EIA's figure for the week was −3.06 million barrels.");
    expect(text).toContain("the forecast was −0.40 (a surprise of −2.55)");
    expect(text).toContain("the forecast was −1.20 (a surprise of +2.87)");
    expect(r.facts.notes.join(" ")).toContain("Investing.com's consensus");
    expect(r.template.check.wrong).toBe(0);
    expect(r.template.check.paragraphs.filter((p) => p.verdict !== "verified")).toEqual([]);
  });

  it("a typed forecast beats the one on record", async () => {
    const { service } = setup({ forecast: { value: -0.1, source: "Forex Factory" } });
    const got = (await service.facts("WPSR", undefined, -4))!;
    expect(got.facts.forecast).toEqual({ value: -4, source: "typed in" });
    expect(got.facts.headline.surprise).toBeCloseTo(0.94, 2);
  });

  it("says why an instrument has no reaction when its candles do not reach the release, and leaves the market section out", async () => {
    const { service } = setup({ bars: () => [] });
    const got = (await service.facts("WPSR"))!;
    expect(got.facts.reaction).toBeUndefined();
    expect(got.facts.notes.join(" ")).toContain("No market reaction for NYMEX WTI");
  });

  it("asks for no reaction before the release has happened", async () => {
    const future = Date.now() + 3600_000;
    let asked = 0;
    const { service } = setup({ stored: stored({ officialReleaseAt: future, scheduledAt: future }), bars: () => (asked++, []) });
    const got = (await service.facts("WPSR"))!;
    expect(asked).toBe(0);
    expect(got.facts.reaction).toBeUndefined();
  });

  it("saves a reaction once its first hour is complete, and not before", async () => {
    const complete = setup(); // quietBars() carries twenty minutes after the release: not complete
    await complete.service.facts("WPSR");
    expect(complete.savedReactions).toHaveLength(0);
    const hour = setup({ bars: () => [...Array.from({ length: 40 }, (_, i) => bar(i - 40, 100)), ...Array.from({ length: 60 }, (_, i) => bar(i, 100 + i / 10))] });
    await hour.service.facts("WPSR");
    expect(hour.savedReactions).toHaveLength(2); // both instruments
    expect(hour.savedReactions[0].slice(0, 3)).toEqual(["WPSR", "2026-10-16", "cl"]);
  });

  it("uses the reaction saved at the time when the candles are no longer available", async () => {
    const saved = { reaction: { symbol: "NYMEX:CL", releaseAt: RELEASE, basePrice: 58.4, moves: [{ minutes: 5, price: 58.8, change: 0.4, pct: 0.68 }], maxUp15: 0.6, maxDown15: 0.1, firstSwing15: "up", high60: 0.8, low60: -0.1, volumeFirst5: 900, volumeBefore5: 300, volumeRatio: 3, minutesCovered: 60 }, micro: null };
    const { service } = setup({ bars: () => [], savedReaction: saved });
    const got = (await service.facts("WPSR"))!;
    expect(got.facts.reaction!.cl.basePrice).toBe(58.4);
    expect(got.facts.reaction!.cl.moves.m5.pct).toBe(0.68);
    expect(got.facts.notes.join(" ")).not.toContain("No market reaction for NYMEX WTI");
  });

  it("is undefined when no report is stored", async () => {
    expect(await setup({ stored: undefined }).service.facts("WPSR")).toBeUndefined();
  });
});

describe("EiaArticleController", () => {
  it("returns the app's article with its check, markdown and the facts, and no Claude article until one is stored", async () => {
    const { controller } = setup();
    const r = await controller.article("WPSR");
    expect(r.template.article.title).toBe("EIA petroleum report: crude draws 3.06 million barrels");
    expect(r.template.check.wrong).toBe(0);
    expect(r.template.markdown).toStartWith("# EIA petroleum report: crude draws 3.06 million barrels");
    expect(r.written).toBeNull();
    expect(r.facts.weekEnding).toBe("2026-10-16");
  });

  it("returns the newest article Claude wrote with its stored verdict and markdown", async () => {
    const written = { id: "ea-1", source: "claude-mcp", at: 1_700_000_000_000, article: { title: "Claude title", dek: "d", sections: [{ heading: "h", paragraphs: [{ text: "p", cites: [] }] }] }, grounding: { total: 1, verified: 1, wrong: 0, other: [], paragraphs: [] } };
    const r = await setup({ writtenRow: written }).controller.article("WPSR");
    expect(r.written?.article.title).toBe("Claude title");
    expect(r.written?.markdown).toContain("Written by Claude from the app's facts");
    expect(r.written?.markdown).toContain("1 of 1 paragraphs checked");
  });

  it("refuses bad input before any lookup and answers 404 when nothing is stored", async () => {
    const { controller } = setup({ stored: undefined });
    await expect(controller.article("STEO")).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.article("WPSR", "last friday")).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.article("WPSR", undefined, "abc")).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.article("WPSR", undefined, "99999")).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.article("WPSR")).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.context("WPSR")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("the agent's route: context, then submit", () => {
  it("gives a context id with the citable figures, then checks the submitted article against THAT context and stores it", async () => {
    const { controller, inserts } = setup();
    const ctx = await controller.context("WPSR");
    expect(ctx.context_id).toStartWith("ectx-");
    expect(ctx.citable["headline.change"]).toBe(-3.06);
    expect(ctx.instructions).toContain("submit_eia_article");

    const good = { report: "WPSR", context_id: ctx.context_id, title: "Crude draws", dek: "A draw.", sections: [{ heading: "The headline", paragraphs: [{ text: "Commercial crude drew 3.06 million barrels.", cites: [{ field: "headline.change", value: "-3.06" }] }, { text: "Stocks fell 9.99 million barrels.", cites: [{ field: "headline.change", value: "-9.99" }] }] }] };
    const r = await controller.submit(good);
    expect(r).toMatchObject({ stored: true, total: 2, verified: 1, wrong: 1 });
    expect(r.paragraphs).toEqual([{ section: "The headline", paragraph: 2, verdict: "wrong", issues: ["headline.change is -3.06, not -9.99."] }]);
    expect(r.next).toContain("Correct those paragraphs");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain("claude-mcp");
  });

  it("refuses an unknown or expired context, a context for the other report, and a malformed article, storing nothing", async () => {
    const { controller, inserts } = setup();
    const ctx = await controller.context("WPSR");
    const base = { report: "WPSR", context_id: ctx.context_id, title: "T", dek: "D", sections: [{ heading: "H", paragraphs: [{ text: "x", cites: [] }] }] };
    await expect(controller.submit({ ...base, context_id: "ectx-nope" })).rejects.toBeInstanceOf(GoneException);
    await expect(controller.submit({ ...base, report: "WNGSR" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.submit({ ...base, sections: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.submit(null)).rejects.toBeInstanceOf(BadRequestException);
    expect(inserts).toHaveLength(0);
  });

  it("a verified article returns no problem paragraphs and says where it will show", async () => {
    const { controller } = setup();
    const ctx = await controller.context("WPSR");
    const r = await controller.submit({ report: "WPSR", context_id: ctx.context_id, title: "Crude draws", dek: "A draw.", sections: [{ heading: "H", paragraphs: [{ text: "Commercial crude drew 3.06 million barrels.", cites: [{ field: "headline.change", value: "-3.06" }] }] }] });
    expect(r).toMatchObject({ verified: 1, wrong: 0, paragraphs: [], other: [] });
    expect(r.next).toContain("Article tab");
  });
});
