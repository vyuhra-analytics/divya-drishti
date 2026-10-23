import { describe, expect, it } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { batchTimes, decodeEntities, extractHeadlines, gkgUrl, isCrudeTitle, parseGkg, titleKey, unzipFirstEntry } from "./gdelt";

/** A one-entry zip file, built by hand: local header, data, central directory, end record. */
function zip(name: string, content: string, deflate = true): Uint8Array {
  const raw = Buffer.from(content, "utf8");
  const data = deflate ? deflateRawSync(raw) : raw;
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(deflate ? 8 : 0, 10);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(n.length, 28);
  cd.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + n.length, 12);
  eocd.writeUInt32LE(30 + n.length + data.length, 16);
  return Buffer.concat([local, n, data, cd, n, eocd]);
}

/** A GKG line: 27 columns, id, date, source, url, themes and the extras that hold the title. */
const line = (batch: string, n: number, source: string, title: string | null, themes = "ECON_OILPRICE;ENV_OIL") => {
  const f = Array(27).fill("");
  f[0] = `${batch}-${n}`;
  f[1] = batch;
  f[2] = "1";
  f[3] = source;
  f[4] = `https://${source}/a${n}`;
  f[7] = themes;
  f[26] = title === null ? "<PAGE_LINKS>x</PAGE_LINKS>" : `<PAGE_LINKS>x</PAGE_LINKS><PAGE_TITLE>${title}</PAGE_TITLE>`;
  return f.join("\t");
};

describe("batches and urls", () => {
  it("lists the quarter hours in the window and writes GDELT's file address", () => {
    const from = Date.UTC(2026, 5, 1, 0, 0);
    const t = batchTimes(from, from + 3_600_000);
    expect(t).toHaveLength(4);
    expect(gkgUrl(t[1])).toBe("https://data.gdeltproject.org/gdeltv2/20260601001500.gkg.csv.zip");
    expect(batchTimes(from + 60_000, from + 16 * 60_000)).toEqual([from + 900_000]); // starts on the next quarter hour
  });
});

describe("reading the zip", () => {
  it("reads a deflated and a stored entry, and refuses what is not a zip", () => {
    expect(unzipFirstEntry(zip("a.csv", "hello\tworld\n"))).toBe("hello\tworld\n");
    expect(unzipFirstEntry(zip("a.csv", "plain", false))).toBe("plain");
    expect(() => unzipFirstEntry(Buffer.from("not a zip file at all, just text padding..."))).toThrow(/not a zip/);
  });
});

describe("parsing rows", () => {
  const text = [line("20260601003000", 1, "reuters.com", "Oil prices jump as OPEC+ signals deeper cuts"), line("20260601003000", 2, "x.com", null), "short\tline", ""].join("\n");

  it("reads the id, the batch time, the source, the themes and the page title; skips short rows", () => {
    const rows = parseGkg(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "20260601003000-1", at: Date.UTC(2026, 5, 1, 0, 30), source: "reuters.com", title: "Oil prices jump as OPEC+ signals deeper cuts" });
    expect(rows[1].title).toBeUndefined();
  });

  it("decodes entities in a title", () => {
    expect(decodeEntities("Shell &#x2013; clean-up &amp; court &#39;s &quot;mess&quot; &#8211; &unknown;")).toBe("Shell – clean-up & court 's \"mess\" – &unknown;");
  });
});

describe("the relevance rule (fixed in advance)", () => {
  it("keeps crude-market headlines, including ones that use a benchmark or the Strait of Hormuz", () => {
    for (const t of ["Oil prices jump as OPEC+ signals deeper cuts", "Brent crude falls below $90 on demand worries", "WTI settles higher after EIA draw", "Iran: 7 oil tankers attacked in the Strait of Hormuz", "US crude inventories fall as refineries ramp up", "Sanctions on Russian oil tighten supply"]) expect([t, isCrudeTitle(t)]).toEqual([t, true]);
  });

  it("drops other kinds of oil and headlines that only mention an oil company", () => {
    for (const t of ["Olive oil prices hit a record high in Spain", "Palm oil futures climb on Indonesian export curbs", "Best essential oil diffusers of 2026", "Barclays Raises PT on ConocoPhillips (COP) Stock", "Katie Price insiders blast Meta", "Engine oil change intervals explained"]) expect([t, isCrudeTitle(t)]).toEqual([t, false]);
  });
});

describe("one headline once", () => {
  it("gives two copies of a story the same key, whatever the punctuation or the publisher suffix", () => {
    expect(titleKey("Oil prices jump as OPEC+ signals deeper cuts - Reuters")).toBe(titleKey("Oil Prices Jump As OPEC+ Signals Deeper Cuts | Bloomberg"));
    expect(titleKey("Brent falls 3%")).not.toBe(titleKey("Brent falls 4%"));
  });

  it("keeps the first copy in a file, drops other kinds of oil and titles that are too short or missing", () => {
    const file = [
      line("20260601003000", 1, "reuters.com", "Oil prices jump as OPEC+ signals deeper cuts - Reuters"),
      line("20260601003000", 2, "bloomberg.com", "Oil Prices Jump As OPEC+ Signals Deeper Cuts | Bloomberg"),
      line("20260601003000", 3, "food.com", "Olive oil prices hit a record high in Spain"),
      line("20260601003000", 4, "a.com", "Oil up"),
      line("20260601003000", 5, "b.com", null),
      line("20260601003000", 6, "c.com", "Brent crude falls below $90 on demand worries"),
    ].join("\n");
    const h = extractHeadlines(file);
    expect(h.map((x) => x.source)).toEqual(["reuters.com", "c.com"]);
    expect(h[0].at).toBe(Date.UTC(2026, 5, 1, 0, 30));
  });
});
