// A screenshot of the Costs panel on Zerodha with the comparison table: `bun e2e/costs-shot.ts` (needs `bun run dev`) -> e2e/screenshots/costs-brokers.png
import { join } from "node:path";
import { chromium } from "playwright-core";
const browser = await (async () => {
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* next */
    }
  }
  throw new Error("no Chrome or Edge found");
})();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
await page.goto(process.env.E2E_WEB ?? "http://localhost:5173");
await page.locator("h1").first().waitFor();
await page.keyboard.press("Escape");
await page.keyboard.press("Control+k");
await page.keyboard.type("COST");
await page.keyboard.press("Enter");
const root = page.locator(".costs").last();
await root.waitFor();
await root.getByLabel("Broker", { exact: true }).selectOption("zerodha");
await root.getByLabel("Compare as", { exact: true }).selectOption("option");
await page.waitForTimeout(500);
await root.scrollIntoViewIfNeeded();
await root.screenshot({ path: join(import.meta.dir, "screenshots", "costs-brokers.png") });
await browser.close();
