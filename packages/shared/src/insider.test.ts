import { expect, test } from "bun:test";
import { parseForm4, recentForm4 } from "./insider";

const xml = `<ownershipDocument>
<reportingOwner><reportingOwnerId><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId>
<reportingOwnerRelationship><isDirector>0</isDirector><officerTitle>SVP</officerTitle></reportingOwnerRelationship></reportingOwner>
<nonDerivativeTable>
<nonDerivativeTransaction>
 <transactionDate><value>2026-10-02</value></transactionDate>
 <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>S</transactionCode></transactionCoding>
 <transactionAmounts><transactionShares><value>1,000</value></transactionShares>
 <transactionPricePerShare><value>110.5</value></transactionPricePerShare>
 <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
</nonDerivativeTransaction>
<nonDerivativeTransaction>
 <transactionDate><value>2026-10-03</value></transactionDate>
 <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
 <transactionAmounts><transactionShares><value>200</value></transactionShares>
 <transactionPricePerShare><value>108</value></transactionPricePerShare>
 <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
</nonDerivativeTransaction>
</nonDerivativeTable></ownershipDocument>`;

test("parseForm4 reads owner, signed shares, price and value", () => {
  const t = parseForm4(xml.replace("1,000", "1000"), "XOM", "u");
  expect(t).toHaveLength(2);
  expect(t[0]).toMatchObject({ owner: "DOE JANE", title: "SVP", date: "2026-10-02", code: "S", shares: -1000, price: 110.5, value: 110500 });
  expect(t[1]).toMatchObject({ code: "P", shares: 200, value: 21600 });
});

test("parseForm4 skips transactions it cannot read", () => {
  expect(parseForm4(xml, "XOM", "u")).toHaveLength(1); // "1,000" is not a number → dropped
  expect(parseForm4("<x/>", "XOM", "u")).toEqual([]);
});

test("recentForm4 keeps only Form 4, strips the xsl folder", () => {
  const sub = { filings: { recent: { form: ["8-K", "4", "4"], accessionNumber: ["a", "b", "c"], primaryDocument: ["x.htm", "xslF345X05/f.xml", "g.xml"], filingDate: ["d1", "d2", "d3"] } } };
  expect(recentForm4(sub, 5)).toEqual([
    { accession: "b", doc: "f.xml", filed: "d2" },
    { accession: "c", doc: "g.xml", filed: "d3" },
  ]);
  expect(recentForm4(sub, 1)).toHaveLength(1);
  expect(recentForm4({}, 5)).toEqual([]);
});
