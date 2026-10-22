// Screenshots of every built-in desk at 1920 x 1080 (one large monitor): `bun e2e/desks.ts` (needs `bun run dev`). Output: e2e/screenshots/desk-<key>.png
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { PRESETS } from "../apps/drishti-web/src/presets";

const WEB = process.env.E2E_WEB ?? "http://localhost:5173";
const dir = join(import.meta.dir, "screenshots");
mkdirSync(dir, { recursive: true });
const browser = await (async () => {
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* try the next */
    }
  }
  throw new Error("no Chrome or Edge found");
})();
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
await page.goto(WEB);
await page.locator("h1").first().waitFor();
await page.keyboard.press("Escape"); // the first-run help dialog
for (const [i, p] of PRESETS.entries()) {
  await page.keyboard.press(`F${i + 1}`);
  await page.waitForTimeout(3500); // charts and panels load their data
  await page.screenshot({ path: join(dir, `desk-${p.key}.png`) });
  console.log(`F${i + 1} ${p.name}`);
}
await browser.close();
