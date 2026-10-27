// Reads the full history of one Investing.com event page the way a person does: a visible Chrome window, the page opened, "Show more" pressed again and again
// with pauses, then the rows saved as text for `parseInvestingPaste`. Owner-directed, one page per run, polite pauses; it STOPS (never works around) when the site
// shows a bot check, a captcha or an access-denied page.   bun run scripts/investing-history.ts <eia_crude|eia_gasoline|eia_distillates|api_crude|eia_gas> [--until=2016-01-01]
import { chromium } from "playwright-core";
import { INVESTING_PAGES } from "../packages/shared/src/investingCalendar";

const series = process.argv[2];
const until = (process.argv.find((a) => a.startsWith("--until=")) ?? "--until=2016-01-01").slice(8);
const page0 = (INVESTING_PAGES as { series: string; url: string }[]).find((p) => p.series === series);
if (!page0) throw new Error(`unknown series ${series}`);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BLOCK = /just a moment|access denied|captcha|verify you are human|are you a robot|unusual traffic/i;
async function blocked(page: import("playwright-core").Page): Promise<string | undefined> {
  const title = await page.title();
  const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 600);
  return BLOCK.test(title) || BLOCK.test(text) ? `${title} | ${text.slice(0, 120).replace(/\s+/g, " ")}` : undefined;
}

let browser;
for (const channel of ["chrome", "msedge"] as const) {
  try {
    browser = await chromium.launch({ channel, headless: false });
    break;
  } catch {}
}
if (!browser) throw new Error("no Chrome or Edge found");
const ctx = await browser.newContext({ timezoneId: "UTC", locale: "en-US", viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const res = await page.goto(page0.url, { waitUntil: "domcontentloaded" });
console.log("opened", page0.url, "status", res?.status());
await pause(6000);
let why = await blocked(page);
if (why || (res && res.status() >= 400)) {
  console.log("STOP: the site is not showing the page:", why ?? res?.status());
  await browser.close();
  process.exit(3);
}
// cookie banner: decline what is optional
for (const label of [/reject all/i, /decline/i, /^i do not accept/i]) {
  const b = page.getByRole("button", { name: label }).first();
  if (await b.isVisible().catch(() => false)) {
    await b.click().catch(() => {});
    await pause(1500);
    break;
  }
}

const rowsText = () => page.locator("table").first().locator("tbody tr").evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim()).join("\t")));
let last = -1;
for (let i = 0; i < 80; i++) {
  const rows = await rowsText();
  const oldest = rows.at(-1) ?? "";
  console.log(`round ${i}: ${rows.length} rows, oldest: ${oldest.slice(0, 60)}`);
  const d = new Date(oldest.split("\t")[0] + " UTC");
  if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) <= until) break;
  if (rows.length === last) break; // nothing new after the last press
  last = rows.length;
  const more = page.locator("table").first().locator('xpath=ancestor::div[3]/div[normalize-space()="Show More"]');
  if (!(await more.isVisible().catch(() => false))) {
    console.log("no 'Show more' button");
    break;
  }
  await more.scrollIntoViewIfNeeded().catch(() => {});
  await more.click();
  await pause(4000);
  why = await blocked(page);
  if (why) {
    console.log("STOP: bot check appeared:", why);
    break;
  }
}
const rows = await rowsText();
await Bun.write(`C:/Users/somun/AppData/Local/Temp/investing-${series}.txt`, rows.join("\n"));
console.log("saved", rows.length, "rows");
await browser.close();
