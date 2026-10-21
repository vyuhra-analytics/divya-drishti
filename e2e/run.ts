// End-to-end tests in a real browser against the running dev stack: `bun run e2e` (start `bun run dev` first).
// A small runner, not `bun test`: that command preloads a fake DOM for the component tests, which a real browser does not want.
// Each test gets a fresh browser context (empty localStorage). Screenshots of every panel are saved to e2e/screenshots/ so a human can look.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const WEB = process.env.E2E_WEB ?? "http://localhost:5173";
const API = process.env.E2E_API ?? "http://127.0.0.1:3001";
const STREAM = process.env.E2E_STREAM ?? "http://127.0.0.1:3002";
const SHOTS = join(import.meta.dir, "screenshots");
mkdirSync(SHOTS, { recursive: true });

class Skip extends Error {}
const skip = (why: string): never => {
  throw new Skip(why);
};
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function up(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(4000) })).ok;
  } catch {
    return false;
  }
}

async function launch(): Promise<Browser> {
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* try the next installed browser */
    }
  }
  return chromium.launch({ headless: true }); // Playwright's own download, if present
}

interface Ctx {
  page: Page;
  context: BrowserContext;
  errors: string[];
}

async function open(browser: Browser): Promise<Ctx> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/favicon|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  await page.goto(WEB);
  await page.locator("h1").first().waitFor({ timeout: 20_000 });
  // the first-run help dialog opens by itself: close it
  await page.keyboard.press("Escape");
  return { page, context, errors };
}

/** Open a panel with the command palette (Ctrl+K, code, Enter) and return its root. */
async function openPanel(page: Page, code: string, rootSelector: string) {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(code);
  await page.keyboard.press("Enter");
  const root = page.locator(rootSelector).last();
  await root.waitFor({ timeout: 15_000 });
  await root.scrollIntoViewIfNeeded();
  return root;
}

const shot = (root: ReturnType<Page["locator"]>, name: string) => root.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => undefined);

const tests: { name: string; run: (c: Ctx, browser: Browser) => Promise<void> }[] = [];
const test = (name: string, run: (c: Ctx, browser: Browser) => Promise<void>) => tests.push({ name, run });

test("the app loads with the default workspace and no script errors", async ({ page, errors }) => {
  await page.waitForTimeout(3000);
  assert((await page.locator("h1").first().innerText()).toLowerCase().includes("divya drishti"), "brand heading missing");
  assert((await page.locator(".react-grid-item").count()) >= 3, "the default workspace has fewer than 3 panels");
  await page.screenshot({ path: join(SHOTS, "workspace.png") });
  assert(errors.length === 0, `script errors: ${errors.join(" | ")}`);
});

test("the default chart and every watchlist row say where their price comes from; no simulated-prices banner on the live feed", async ({ page }) => {
  await page.waitForFunction(() => document.querySelectorAll(".watchlist .badge").length >= 6, undefined, { timeout: 20_000 });
  const rows = await page.locator(".watchlist .badge").allInnerTexts();
  assert(rows.every((t) => ["UPSTOX", "TV", "YAHOO"].includes(t.trim())), `unexpected watchlist badges: ${rows.join(",")}`);
  assert((await page.locator(".adv-replay .badge").count()) >= 1, "the default chart shows no feed badge");
  assert((await page.locator(".sim-banner").count()) === 0, "the SIMULATED PRICES banner shows on the live feed");
  await page.locator(".watchlist").first().screenshot({ path: join(SHOTS, "watchlist.png") });
});

test("demo feed: the SIMULATED PRICES banner and a DEMO badge on every chart, quote and watchlist row", async (_c, browser) => {
  // a second stream in demo mode on its own port; Telegram is blanked so no stored server alert can message a real chat from simulated prices
  const demo = Bun.spawn(["bun", "--env-file=../../.env", "src/index.ts"], {
    cwd: join(import.meta.dir, "../apps/drishti-core-stream"),
    env: { ...process.env, STREAM_PORT: "3012", FEED: "demo", UPSTOX_ACCESS_TOKEN: "", TELEGRAM_BOT_TOKEN: "", ALERT_WEBHOOK_URL: "" },
    stdout: "ignore",
    stderr: "ignore",
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    for (let i = 0; i < 30 && !(await up("http://127.0.0.1:3012/health")); i++) await Bun.sleep(500);
    assert(await up("http://127.0.0.1:3012/health"), "the demo stream did not start");
    await ctx.addInitScript(() => localStorage.setItem("drishti-settings", JSON.stringify({ state: { streamUrl: "ws://127.0.0.1:3012/ws" }, version: 0 })));
    const page = await ctx.newPage();
    await page.goto(WEB);
    await page.locator("h1").first().waitFor({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await page.locator(".sim-banner").waitFor({ timeout: 15_000 });
    assert((await page.locator(".sim-banner").innerText()).includes("SIMULATED PRICES"), "banner text wrong");
    await page.waitForFunction(() => document.querySelectorAll(".watchlist .badge").length >= 6, undefined, { timeout: 15_000 });
    const rows = await page.locator(".watchlist .badge").allInnerTexts();
    assert(rows.every((t) => t.trim() === "DEMO"), `watchlist badges: ${rows.join(",")}`);
    assert((await page.locator(".adv-replay .badge").allInnerTexts()).every((t) => t.trim() === "DEMO"), "a chart is missing its DEMO badge");
    assert((await page.locator(".quote-foot .badge").allInnerTexts()).includes("DEMO"), "the quote panel is missing its DEMO badge");
    await page.screenshot({ path: join(SHOTS, "demo-feed.png") });
  } finally {
    await ctx.close();
    demo.kill();
  }
});

test("live prices reach the top bar", async ({ page }) => {
  await page.waitForFunction(() => /CRUDEOIL\s*[\d,]+/.test(document.body.innerText), undefined, { timeout: 20_000 });
});

test("Costs panel: gross-to-net bridge and a position size from the live price", async ({ page }) => {
  const root = await openPanel(page, "COST", ".costs");
  await root.getByText("Gross P&L").waitFor({ timeout: 10_000 });
  assert((await root.getByText("Net P&L").count()) === 1, "net P&L row missing");
  assert((await root.getByText(/lots? ·/).count()) >= 1, "position size line missing");
  await shot(root, "costs");
});

test("Strategy tester: runs on real history and shows the doubts and the validation", async ({ page }) => {
  const root = await openPanel(page, "BT", ".bt");
  await root.getByRole("button", { name: "Run test" }).click();
  await root.getByText("Is it luck?").waitFor({ timeout: 60_000 });
  await root.getByText(/Reasons for doubt|Nothing here argues against it/).waitFor();
  assert((await root.getByText("Net P&L").count()) >= 1, "metrics missing");
  assert((await root.getByText(/Walk-forward/).count()) >= 1, "walk-forward section missing");
  await shot(root, "backtest");
});

test("Paper trading: buy at market, see the position, close it, find it in the journal", async ({ page }) => {
  const root = await openPanel(page, "PT", ".paper");
  const buy = root.getByRole("button", { name: /^Buy 1 lot/ });
  await buy.waitFor({ timeout: 10_000 });
  if (await root.getByText(/market (closed|stale)/).count()) skip("the market is closed or the feed is quiet: paper orders wait for a live price");
  await buy.click();
  await root.getByRole("cell", { name: "Long", exact: true }).waitFor({ timeout: 5000 }); // the position row (not the "Buy (long)" option)
  await shot(root, "paper-open");
  await root.getByRole("button", { name: "Close", exact: true }).first().click();
  await root.getByText("Closed by hand").waitFor({ timeout: 5000 });
  await root.getByLabel(/^Note for the/).first().fill("e2e check");
  await shot(root, "paper-journal");
});

test("Data quality: feed health, price agreement and source checks", async ({ page }) => {
  const root = await openPanel(page, "DQ", ".dq");
  await root.getByText("Live feeds").waitFor();
  await root.getByRole("cell", { name: "upstox" }).first().waitFor({ timeout: 15_000 });
  await root.getByText("Price agreement between feeds").waitFor();
  await root.getByText("Source checks").waitFor();
  await root.getByRole("cell", { name: "cftc-cot" }).waitFor({ timeout: 20_000 });
  await shot(root, "quality");
});

test("Alerts: the server-alert delivery status is shown (nothing is sent)", async ({ page }) => {
  const root = await openPanel(page, "AL", ".alerts");
  await root.getByText(/Server alerts:/).waitFor({ timeout: 15_000 });
  assert((await root.getByLabel(/From the server/).count()) === 1, "the From the server option is missing");
  await shot(root, "alerts");
});

for (const [code, selector, text, name] of [
  ["COT", ".cot", "Managed money net", "cot"],
  ["CHK", ".chk", "Strait of Hormuz", "chokepoints"],
  ["CRV", ".curve", "Shape", "curve"],
  ["JODI", ".jodi", "Crude oil", "jodi"],
  ["RCP", ".recap", "Built from fixed templates", "recap"],
  ["EIA", ".eia", "Crude stocks", "eia"],
] as const) {
  test(`${name} panel renders real data`, async ({ page }) => {
    const root = await openPanel(page, code, selector);
    await root.getByText(text, { exact: false }).first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500); // let the whole panel load before looking for badges
    assert((await root.getByText("OUTDATED").count()) === 0, `${name}: current data is marked OUTDATED (freshness budget too tight?)`);
    await shot(root, name);
  });
}

// ---- run
const reachable = await Promise.all([up(WEB), up(`${API}/health`), up(`${STREAM}/health`)]);
if (reachable.includes(false)) {
  console.error(`The dev stack is not running (web ${reachable[0]}, api ${reachable[1]}, stream ${reachable[2]}). Start it with: bun run dev`);
  process.exit(2);
}
const browser = await launch();
let failed = 0;
let skipped = 0;
let ran = 0;
const only = process.argv.slice(2).map((x) => x.toLowerCase());
for (const t of tests.filter((x) => !only.length || only.some((o) => x.name.toLowerCase().includes(o)))) {
  ran++;
  const c = await open(browser);
  const t0 = Date.now();
  try {
    await t.run(c, browser);
    console.log(`PASS  ${t.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    if (e instanceof Skip) {
      skipped++;
      console.log(`SKIP  ${t.name}: ${e.message}`);
    } else {
      failed++;
      console.log(`FAIL  ${t.name}: ${(e as Error).message.split("\n")[0]}`);
      await c.page.screenshot({ path: join(SHOTS, `FAIL-${t.name.replace(/\W+/g, "-").slice(0, 40)}.png`) }).catch(() => undefined);
    }
  } finally {
    await c.context.close();
  }
}
await browser.close();
console.log(`\n${ran - failed - skipped} passed, ${failed} failed, ${skipped} skipped. Screenshots: e2e/screenshots/`);
process.exit(failed ? 1 : 0);
