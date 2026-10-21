import { expect, test } from "bun:test";
import { parseJodi, summarizeJodi } from "./jodi";

// rows copied from the real file (India reports REFINOBS to 2026-03, then "-"; stocks are KBBL)
const csv = [
  "REF_AREA,TIME_PERIOD,ENERGY_PRODUCT,FLOW_BREAKDOWN,UNIT_MEASURE,OBS_VALUE,ASSESSMENT_CODE",
  "IN,2025-03,CRUDEOIL,REFINOBS,KBD,5692.2552,3",
  "IN,2026-02,CRUDEOIL,REFINOBS,KBD,5704.1168,3",
  "IN,2026-03,CRUDEOIL,REFINOBS,KBD,5568.6294,3",
  "IN,2026-04,CRUDEOIL,REFINOBS,KBD,-,3", // not reported yet
  "IN,2026-03,CRUDEOIL,REFINOBS,KL,885000.0000,3", // wrong unit for a flow
  "IN,2026-03,CRUDEOIL,CLOSTLV,KBBL,x,3", // not applicable
  "IN,2026-03,TOTCRUDE,REFINOBS,KBD,0.0000,3", // other product
  "SA,2026-08,CRUDEOIL,CLOSTLV,KBBL,143197.0000,3",
  "SA,2026-07,CRUDEOIL,CLOSTLV,KBBL,175632.0000,3",
  "FR,2026-08,CRUDEOIL,CLOSTLV,KBBL,1.0000,1", // country not asked for
  "",
].join("\n");

test("parseJodi keeps reported crude values for the asked countries and units only", () => {
  const p = parseJodi(csv, ["IN", "SA"]);
  expect(p.map((x) => `${x.country} ${x.month} ${x.flow} ${x.value}`)).toEqual([
    "IN 2025-03 REFINOBS 5692.2552",
    "IN 2026-02 REFINOBS 5704.1168",
    "IN 2026-03 REFINOBS 5568.6294",
    "SA 2026-08 CLOSTLV 143197",
    "SA 2026-07 CLOSTLV 175632",
  ]);
  expect(parseJodi("", ["IN"])).toEqual([]);
});

test("summarizeJodi finds the latest reported month and changes, with the year-ago month only when reported", () => {
  const p = parseJodi(csv, ["IN", "SA"]);
  const refin = summarizeJodi(p, "IN").find((s) => s.flow === "REFINOBS")!;
  expect(refin.latest).toMatchObject({ month: "2026-03", value: 5568.6294 });
  expect(refin.momPct).toBeCloseTo(((5568.6294 - 5704.1168) / 5704.1168) * 100, 9);
  expect(refin.yoyPct).toBeCloseTo(((5568.6294 - 5692.2552) / 5692.2552) * 100, 9);
  const stocks = summarizeJodi(p, "SA").find((s) => s.flow === "CLOSTLV")!;
  expect(stocks.latest?.month).toBe("2026-08");
  expect(stocks.momPct).toBeCloseTo(((143197 - 175632) / 175632) * 100, 9);
  expect(stocks.yoyPct).toBeUndefined(); // no 2025-08 row
  expect(summarizeJodi(p, "IN").find((s) => s.flow === "TOTIMPSB")!.latest).toBeUndefined();
});
