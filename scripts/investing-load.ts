// Load the history saved by scripts/investing-history.ts into release_forecasts. Times in those files are UTC. Existing figures are kept when a row has none.
//   bun run scripts/investing-load.ts [--dry]
import { SQL } from "bun";
import { INVESTING_PAGES } from "../packages/shared/src/investingCalendar";
import { parseInvestingPaste } from "../packages/shared/src/investingPaste";
import { ForecastService } from "../apps/drishti-core-api/src/forecast.service";

const dry = process.argv.includes("--dry");
const sql = new SQL(process.env.DATABASE_URL!);
const svc = new ForecastService({ sql } as never);
for (const p of INVESTING_PAGES) {
  const file = Bun.file(`C:/Users/somun/AppData/Local/Temp/investing-${p.series}.txt`);
  if (!(await file.exists())) { console.log(p.series, "no file"); continue; }
  const rows = parseInvestingPaste(await file.text(), "UTC");
  const withF = rows.filter((r) => r.forecast !== undefined).length;
  console.log(p.series, rows.length, "rows,", withF, "with a forecast,", new Date(rows[0].at).toISOString().slice(0, 10), "to", new Date(rows.at(-1)!.at).toISOString().slice(0, 10));
  if (!dry) await svc.store(p.series as never, rows.map((r) => ({ releaseAt: r.at, forecast: r.forecast, previous: r.previous, actual: r.actual, unit: p.series === "eia_gas" ? "B" : "M" })) as never);
}
await sql.close();
