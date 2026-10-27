import { describe, expect, it } from "bun:test";
import { archiveReleaseTime, archiveTableUrl, parseArchiveIndex } from "./eiaArchive";

// the links as the real index page writes them (2026-10-27), with one data-only re-release folder
const INDEX = `
<li><a href="/petroleum/supply/weekly/archive/2026/2026_10_21/wpsr_2026_10_21.php">October 21</a></li>
<li><a href="/petroleum/supply/weekly/archive/2026/2026_10_14/wpsr_2026_10_14.php">October 14</a></li>
<li><a href="/petroleum/supply/weekly/archive/2022/2022_06_17_data/wpsr_2022_06_17_data.php">June 17 data</a></li>
<li><a href="/petroleum/supply/weekly/archive/2022/2022_06_15/wpsr_2022_06_15.php">June 15</a></li>
<li><a href="/petroleum/supply/weekly/archive/2011/2011_10_26/wpsr_2011_10_26.html">October 26</a></li>
<li><a href="/petroleum/supply/weekly/archive/2026/2026_10_21/wpsr_2026_10_21.php">October 21 again</a></li>
<a href="/petroleum/supply/weekly/archive/2026/2026_10_21/csv/table1.csv">not a release page</a>
<a href="/petroleum/supply/weekly/">the weekly page</a>`;

describe("parseArchiveIndex", () => {
  it("lists each release once, newest first, with its date and year, including data-only re-release folders", () => {
    const r = parseArchiveIndex(INDEX);
    expect(r.map((x) => x.folder)).toEqual(["2026_10_21", "2026_10_14", "2022_06_17_data", "2022_06_15", "2011_10_26"]);
    expect(r[0]).toEqual({ folder: "2026_10_21", day: "2026-10-21", year: 2026 });
    expect(r[2]).toEqual({ folder: "2022_06_17_data", day: "2022-06-17", year: 2022 });
  });

  it("returns nothing for a page with no release links", () => expect(parseArchiveIndex("<html>no links</html>")).toEqual([]));
});

describe("archive addresses and times", () => {
  it("builds the csv address of a table of a release", () => {
    expect(archiveTableUrl({ folder: "2026_10_21", day: "2026-10-21", year: 2026 }, 5)).toBe("https://www.eia.gov/petroleum/supply/weekly/archive/2026/2026_10_21/csv/table5.csv");
    expect(archiveTableUrl({ folder: "2022_06_17_data", day: "2022-06-17", year: 2022 }, 1)).toContain("/2022/2022_06_17_data/csv/table1.csv");
  });

  it("dates a release at 10:30 New York, daylight saving included", () => {
    expect(new Date(archiveReleaseTime({ folder: "2026_10_21", day: "2026-10-21", year: 2026 })).toISOString()).toBe("2026-10-21T14:30:00.000Z"); // EDT
    expect(new Date(archiveReleaseTime({ folder: "2026_01_07", day: "2026-01-07", year: 2026 })).toISOString()).toBe("2026-01-07T15:30:00.000Z"); // EST
  });
});
