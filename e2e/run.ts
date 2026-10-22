// End-to-end tests in a real browser against the running dev stack: `bun run e2e` (start `bun run dev` first).
// A small runner, not `bun test`: that command preloads a fake DOM for the component tests, which a real browser does not want.
// Each test gets a fresh browser context (empty localStorage). Screenshots of every panel are saved to e2e/screenshots/ so a human can look.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

test("a layout saved before JODI was removed still loads: the JODI panel is dropped, the others stay, nothing crashes", async ({ context, page, errors }) => {
  const w = (id: string, type: string) => ({ id, type, group: "amber", symbol: "MCX:CRUDEOIL", tf: "5m" });
  const old = {
    state: {
      widgets: [w("quote-1", "quote"), w("jodi-1", "jodi"), w("watch-1", "watchlist")],
      layout: [{ i: "quote-1", x: 0, y: 0, w: 4, h: 9 }, { i: "jodi-1", x: 4, y: 0, w: 4, h: 8 }, { i: "watch-1", x: 8, y: 0, w: 4, h: 7 }],
      groups: { amber: "MCX:CRUDEOIL", blue: "NYMEX:CL", green: "MCX:NATURALGAS", red: "NYMEX:NG" },
      focusedId: "jodi-1",
      saved: {},
      activeWorkspace: null,
    },
    version: 2,
  };
  const page2 = await context.newPage();
  await page2.addInitScript((v) => localStorage.setItem("drishti-workspace", JSON.stringify(v)), old);
  await page2.goto(WEB);
  await page2.locator("h1").first().waitFor();
  await page2.waitForTimeout(1500);
  assert((await page2.locator(".react-grid-item").count()) === 2, "the layout should keep exactly the quote and the watchlist");
  assert((await page2.locator(".jodi").count()) === 0, "a JODI panel is still on screen");
  const kept = JSON.parse((await page2.evaluate(() => localStorage.getItem("drishti-workspace"))) ?? "{}");
  assert(kept.version === 3 && !JSON.stringify(kept).includes("jodi"), "the stored layout still mentions JODI or was not migrated");
  void page;
  void errors;
});

test("the default chart and every watchlist row say where their price comes from; no simulated-prices banner on the live feed", async ({ page }) => {
  await page.waitForFunction(() => document.querySelectorAll(".watchlist .badge").length >= 6, undefined, { timeout: 20_000 });
  const rows = await page.locator(".watchlist .badge").allInnerTexts();
  assert(rows.every((t) => ["UPSTOX", "TV", "YAHOO", "≠"].includes(t.trim())), `unexpected watchlist badges: ${rows.join(",")}`);
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

test("Ticker tape: scrolls, shows live price, change and expiry for every symbol, pauses on hover", async ({ page }) => {
  const tape = page.getByLabel("Price ticker");
  await tape.waitFor();
  await page.waitForFunction(() => /CRUDEOIL\s*[\d,]+\s*[+−-][\d,.]+ \([+−-][\d.]+%\)\s*Exp\. \d+ \w{3}/.test(document.querySelector(".tape")?.textContent ?? ""), undefined, { timeout: 20_000 });
  await page.waitForFunction(() => /USDINR\s*[\d.]+\s*[+−-][\d.]+ \([+−-][\d.]+%\)/.test(document.querySelector(".tape")?.textContent ?? ""), undefined, { timeout: 20_000 });
  const x = () => page.locator(".tape-track").evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  const a = await x();
  await page.waitForTimeout(1200);
  assert((await x()) < a, "the tape is not moving");
  await tape.hover();
  const b = await x();
  await page.waitForTimeout(800);
  assert((await x()) === b, "the tape did not pause on hover");
  await page.mouse.move(0, 400);
  await page.screenshot({ path: join(SHOTS, "ticker-tape.png"), clip: { x: 0, y: 0, width: 1280, height: 70 } });
});

test("USD/INR: live in the watchlist, on a chart with history, and not offered where it makes no sense (paper trading, futures curve)", async ({ page }) => {
  await page.waitForFunction(() => /USDINR.*?\d{2}\.\d{4}/.test(document.querySelector(".watchlist")?.textContent ?? ""), undefined, { timeout: 20_000 });
  const bars = await (await fetch(`${API}/bars?symbol=FX:USDINR&tf=5m`)).json();
  assert(Array.isArray(bars) && bars.length > 100, `USD/INR history has ${bars?.length} bars`);
  await page.keyboard.press("Control+k");
  await page.keyboard.type("USDINR GP");
  await page.keyboard.press("Enter");
  const chart = page.locator(".adv-chart").last();
  await chart.waitFor({ timeout: 20_000 });
  await chart.scrollIntoViewIfNeeded();
  await chart.locator("canvas").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(3000);
  await shot(page.locator(".adv-wrap").last(), "usdinr-chart");
  const curve = await openPanel(page, "CRV", ".curve");
  assert((await curve.getByRole("button", { name: "USDINR" }).count()) === 0, "the futures curve offers USD/INR");
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

/** A throwaway paper account for a test: the user's real account is never touched. Deleted afterwards. */
const PAPER = `${STREAM}/paper`;
async function withPaperAccount<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const made = await fetch(`${PAPER}/accounts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, capital: 500000, slippage: 1 }) });
  assert(made.ok || made.status === 409, `could not create the ${id} paper account: HTTP ${made.status} (is the database migrated? bun run db:migrate)`);
  try {
    return await fn();
  } finally {
    const open = (await (await fetch(`${PAPER}/accounts/${id}`)).json().catch(() => null))?.state?.positions ?? [];
    for (const p of open) await fetch(`${PAPER}/accounts/${id}/positions/${p.id}/close`, { method: "POST" });
    await fetch(`${PAPER}/accounts/${id}`, { method: "DELETE" });
  }
}
const useAccount = (ctx: BrowserContext, id: string) => ctx.addInitScript((a) => localStorage.setItem("drishti-paper-account", a), id);

test("Paper trading (server account): buy at market, see the position, close it, find it in the journal", async ({ page, context }) => {
  await withPaperAccount("e2e", async () => {
    await useAccount(context, "e2e");
    await page.reload();
    await page.locator("h1").first().waitFor();
    await page.keyboard.press("Escape");
    const root = await openPanel(page, "PT", ".paper");
    const buy = root.getByRole("button", { name: /^Buy 1 lot/ });
    await buy.waitFor({ timeout: 10_000 });
    if (await root.getByText(/market (closed|stale)/).count()) skip("the market is closed or the feed is quiet: paper orders wait for a live price");
    await buy.click();
    await root.getByRole("cell", { name: "Long", exact: true }).waitFor({ timeout: 5000 }); // the position row (not the "Buy (long)" option)
    await shot(root, "paper-open");
    await root.getByRole("button", { name: "Close", exact: true }).first().click();
    await root.getByText("Closed by hand").waitFor({ timeout: 5000 });
    const note = root.getByLabel(/^Note for the/).first();
    await note.fill("e2e check");
    await note.blur();
    await page.waitForTimeout(500);
    await page.reload(); // the account is on the server: it survives a reload and shows the note
    await page.locator("h1").first().waitFor();
    await page.keyboard.press("Escape");
    const again = await openPanel(page, "PT", ".paper");
    assert((await again.getByLabel(/^Note for the/).first().inputValue()) === "e2e check", "the journal note did not survive a reload");
    await shot(again, "paper-journal");
  });
});

test("MCP -> UI: a paper order Claude places over MCP appears in the Paper panel, and closing it over MCP updates the journal", async ({ page, context }) => {
  await withPaperAccount("e2e", async () => {
    await useAccount(context, "e2e");
    await page.reload();
    await page.locator("h1").first().waitFor();
    await page.keyboard.press("Escape");
    const root = await openPanel(page, "PT", ".paper");
    await root.getByText("None.").first().waitFor({ timeout: 10_000 });
    if (await root.getByText(/market (closed|stale)/).count()) skip("the market is closed or the feed is quiet: paper orders wait for a live price");

    // a real MCP client talking to the real MCP server over stdio, exactly as Claude Code or Claude Desktop would
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["src/index.ts"],
      cwd: join(import.meta.dir, "../apps/drishti-mcp"),
      env: { ...(process.env as Record<string, string>), MCP_PAPER_WRITE: "1", MCP_PAPER_ACCOUNT: "e2e", TELEGRAM_BOT_TOKEN: "" },
      stderr: "ignore",
    });
    const mcp = new Client({ name: "e2e", version: "1" });
    await mcp.connect(transport);
    try {
      const tools = (await mcp.listTools()).tools.map((t) => t.name);
      assert(tools.includes("place_paper_order"), `the MCP server did not offer place_paper_order: ${tools.join(", ")}`);
      const labelled = { symbol: "MCX:CRUDEOIL", side: "buy", lots: 1, client_order_id: `e2e-${Date.now()}`, strategy: "E2E", tag: "e2e-label", signal_time: new Date().toISOString(), r_points: 10 };
      const placed: any = await mcp.callTool({ name: "place_paper_order", arguments: labelled });
      assert(!placed.isError, `MCP order refused: ${placed.content?.[0]?.text}`);
      // a retry with the same client order id is the same order: nothing new fills
      const retry: any = await mcp.callTool({ name: "place_paper_order", arguments: labelled });
      assert(!retry.isError && JSON.parse(retry.content[0].text).duplicate === true, `the retry was not recognised as a duplicate: ${retry.content?.[0]?.text}`);
      assert(JSON.parse(retry.content[0].text).filled.id === JSON.parse(placed.content[0].text).filled.id, "the retry answered with a different position");
      // ... and the browser shows it without any click or reload
      await root.getByRole("cell", { name: "Long", exact: true }).waitFor({ timeout: 6000 });
      await root.getByText("Claude (MCP)").first().waitFor({ timeout: 2000 });
      await root.getByText("E2E · e2e-label").first().waitFor({ timeout: 2000 }); // the strategy and tag the order carried
      assert((await root.getByRole("cell", { name: "Long", exact: true }).count()) === 1, "the retry opened a second position");
      await page.getByText(/Claude opened 1 lot MCX:CRUDEOIL long/).first().waitFor({ timeout: 3000 }); // the toast
      await shot(root, "mcp-order-in-ui");

      const id = JSON.parse(placed.content[0].text).filled.id;
      const closed: any = await mcp.callTool({ name: "close_paper_position", arguments: { position_id: id } });
      assert(!closed.isError, `MCP close refused: ${closed.content?.[0]?.text}`);
      await root.getByText("closed by Claude").waitFor({ timeout: 6000 });
      assert((await root.getByRole("cell", { name: "Long", exact: true }).count()) === 0, "the position is still shown as open after Claude closed it");
      await shot(root, "mcp-close-in-ui");
    } finally {
      await mcp.close();
    }
  });
});

test("MCP -> UI: Claude reads the app's facts over MCP, submits a briefing, the checks catch a wrong figure, and the corrected one shows as verified", async ({ page }) => {
  const root = await openPanel(page, "BR", ".brief");
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["src/index.ts"],
    cwd: join(import.meta.dir, "../apps/drishti-mcp"),
    env: { ...(process.env as Record<string, string>), MCP_BRIEFING_WRITE: "1", MCP_PAPER_WRITE: "", TELEGRAM_BOT_TOKEN: "" },
    stderr: "ignore",
  });
  const mcp = new Client({ name: "e2e", version: "1" });
  await mcp.connect(transport);
  try {
    const got: any = await mcp.callTool({ name: "get_briefing_context", arguments: { symbol: "MCX:CRUDEOIL" } });
    if (got.isError && /no live price/.test(got.content?.[0]?.text)) skip("no live price yet");
    assert(!got.isError, `get_briefing_context failed: ${got.content?.[0]?.text}`);
    const facts = JSON.parse(got.content[0].text);
    assert(facts.context_id && facts.citable?.price !== undefined && facts.instructions, "the context lacks an id, the citable fields or the instructions");
    const rsi = facts.citable["technicals.rsi14"];
    const submit = async (price: string, summary: string) => {
      const r: any = await mcp.callTool({
        name: "submit_briefing",
        arguments: {
          symbol: "MCX:CRUDEOIL",
          context_id: facts.context_id,
          bias: "bullish",
          confidence: "low",
          summary,
          bull: [{ point: `Price is ${price}`, evidence: `price ${price}`, cites: [{ field: "price", value: price }] }],
          bear: rsi === undefined ? [] : [{ point: `RSI is ${rsi}`, evidence: `rsi14 ${rsi}`, cites: [{ field: "technicals.rsi14", value: String(rsi) }] }],
        },
      });
      assert(!r.isError, `submit_briefing refused: ${r.content?.[0]?.text}`);
      return JSON.parse(r.content[0].text);
    };
    // 1) a wrong figure: stored, and the agent is told which point and what the data holds
    const wrong = await submit(String(facts.citable.price + 777), "[e2e] wrong figure");
    assert(wrong.wrong === 1 && wrong.points[0].issues[0].includes(`price is ${facts.citable.price}`), `the wrong figure was not caught: ${JSON.stringify(wrong)}`);
    await root.getByText("[e2e] wrong figure").waitFor({ timeout: 6000 });
    await root.getByText(/Data says: price is/).waitFor({ timeout: 2000 });
    await page.getByText(/Claude wrote a bullish briefing on CRUDEOIL/).first().waitFor({ timeout: 3000 }); // the notice
    // 2) the agent corrects it: verified
    const fixed = await submit(String(facts.citable.price), "[e2e] corrected");
    assert(fixed.wrong === 0, `the corrected briefing still has wrong points: ${JSON.stringify(fixed)}`);
    await root.getByText("[e2e] corrected").waitFor({ timeout: 6000 });
    await root.getByText(/points checked against the data/).waitFor({ timeout: 2000 });
    await root.getByText(/Written by Claude over MCP/).waitFor({ timeout: 2000 });
    await shot(root, "mcp-briefing-in-ui");
  } finally {
    await mcp.close();
  }
});

test("MCP read tools: instruments, market status, technicals, recap, news, calendar, candles and the option chain all answer from the live stack", async () => {
  const transport = new StdioClientTransport({ command: "bun", args: ["src/index.ts"], cwd: join(import.meta.dir, "../apps/drishti-mcp"), env: { ...(process.env as Record<string, string>), MCP_PAPER_WRITE: "", MCP_BRIEFING_WRITE: "", TELEGRAM_BOT_TOKEN: "" }, stderr: "ignore" });
  const mcp = new Client({ name: "e2e", version: "1" });
  await mcp.connect(transport);
  try {
    const ask = async (name: string, args: Record<string, unknown> = {}) => {
      const r: any = await mcp.callTool({ name, arguments: args });
      assert(!r.isError, `${name} failed: ${r.content?.[0]?.text}`);
      return JSON.parse(r.content[0].text);
    };
    assert((await ask("list_instruments")).length >= 7, "list_instruments is missing the built-ins");
    const status = await ask("get_market_status");
    assert(status.instruments.length >= 7 && status.sessions.MCX && status.feeds.upstox, "get_market_status is incomplete");
    const t = await ask("get_technicals", { symbol: "MCX:CRUDEOIL", timeframe: "1h" });
    assert(t.technicals.rsi14 !== undefined && t.provenance.price.quality, "get_technicals lacks indicators or provenance");
    assert((await ask("get_recap", { symbol: "MCX:CRUDEOIL" })).headline.includes("Crude Oil"), "get_recap has no headline");
    assert((await ask("get_news", { limit: 3 })).notice.includes("untrusted"), "get_news does not mark headlines as untrusted");
    await ask("get_calendar", { days: 3 });
    const bars = await ask("get_bars", { symbol: "FX:USDINR", limit: 5 });
    assert(bars.bars.length === 5 && !bars.bars.some((b: any) => b.forming), "get_bars returned a forming candle or the wrong count");
    const chain = await ask("get_option_chain", { underlying: "CRUDEOIL", strikes_each_side: 4 });
    assert(chain.rows?.length >= 5, "get_option_chain has too few strikes");
  } finally {
    await mcp.close();
  }
});

test("Detailed option chain: every column of the Upstox-style chain, spot marker, load more, column chooser that persists", async ({ page }) => {
  const root = await openPanel(page, "OCX", ".ocx");
  await root.locator("tbody tr").nth(8).waitFor({ timeout: 30_000 });
  const heads = (await root.locator("thead tr").nth(1).locator("th").allInnerTexts()).map((t) => t.trim());
  for (const h of ["Volume", "IV", "Vega", "Gamma", "Theta", "Delta", "OI chg", "OI", "Bid", "Ask", "LTP", "Strike"]) assert(heads.includes(h), `column ${h} is missing: ${heads.join(",")}`);
  assert((await root.locator("tr.ocx-spot").count()) === 1, "no spot marker row");
  assert((await root.getByText("Build Strategy").count()) === 0, "the Build Strategy button should be omitted");
  assert((await root.locator("td.ocx-strike small").first().innerText()).startsWith("PCR"), "PCR per strike is missing");
  const before = await root.locator("tbody tr:not(.ocx-more):not(.ocx-spot)").count();
  await root.getByRole("button", { name: /Load more strikes/ }).click();
  await page.waitForFunction((n) => document.querySelectorAll(".ocx tbody tr:not(.ocx-more):not(.ocx-spot)").length > n, before, { timeout: 15_000 });
  await root.locator("summary").click();
  await root.getByLabel("Gamma").uncheck();
  assert(!(await root.locator("thead tr").nth(1).locator("th").allInnerTexts()).map((t) => t.trim()).includes("Gamma"), "Gamma column did not hide");
  await page.reload();
  await page.locator("h1").first().waitFor();
  await page.keyboard.press("Escape");
  const again = await openPanel(page, "OCX", ".ocx");
  await again.locator("tbody tr").nth(8).waitFor({ timeout: 30_000 });
  assert(!(await again.locator("thead tr").nth(1).locator("th").allInnerTexts()).map((t) => t.trim()).includes("Gamma"), "the column choice did not survive a reload");
  await shot(again, "option-chain-detailed");
});

test("Instruments: add a NYMEX future in Settings, see it priced in the watchlist and known to the API, then remove it", async ({ page }) => {
  const symbol = "NYMEX:RB";
  const drop = () => fetch(`${STREAM}/instruments/${encodeURIComponent(symbol)}`, { method: "DELETE" }).catch(() => undefined);
  await drop(); // a leftover from an aborted run
  await page.goto(WEB);
  await page.locator("h1").first().waitFor();
  try {
    await page.keyboard.press("Control+,");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    const form = dialog.getByRole("form", { name: "Add instrument" });
    await form.getByLabel("Exchange").selectOption("NYMEX");
    await form.getByLabel("Symbol", { exact: true }).fill("rb");
    await form.getByLabel("Name").fill("RBOB Gasoline");
    await form.getByLabel("Lot").fill("42000 gal");
    await form.getByLabel("Price decimals").selectOption("4");
    await form.scrollIntoViewIfNeeded();
    await shot(form, "instruments-form");
    await form.getByRole("button", { name: "Add instrument" }).click();
    await dialog.getByText("RBOB Gasoline").waitFor({ timeout: 15_000 });
    await dialog.getByText(/added by you/).waitFor();
    await page.keyboard.press("Escape");
    // the stream prices it from Yahoo and TradingView within a few seconds, and the watchlist lists it
    await page.waitForFunction(() => [...document.querySelectorAll(".watchlist")].some((w) => /RB/.test(w.textContent ?? "") && /\d\.\d{4}/.test(w.textContent ?? "")), undefined, { timeout: 30_000 });
    await shot(page.locator(".watchlist").first(), "instruments-watchlist");
    // the API learns of it within 30 s (it asks the stream), after which history works
    const until = Date.now() + 45_000;
    let status = 0;
    while (Date.now() < until) {
      status = (await fetch(`${API}/bars?symbol=${encodeURIComponent(symbol)}&tf=5m`)).status;
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert(status === 200, `the API never accepted ${symbol} (last status ${status})`);
    // removing it takes it out of the watchlist
    await page.keyboard.press("Control+,");
    page.once("dialog", (d) => void d.accept());
    await dialog.locator(".field", { hasText: "RBOB Gasoline" }).getByRole("button", { name: "Remove" }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll(".watchlist")].some((w) => /RBOB|NYMEX:RB\b/.test(w.textContent ?? "")), undefined, { timeout: 15_000 });
  } finally {
    await drop();
  }
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
