// Record real provider responses as test fixtures: `bun run fixtures:refresh [id ...]` (needs network; EIA also needs EIA_API_KEY in .env).
// Each source is run through its real code path against the live provider, the responses are trimmed and written to
// packages/shared/fixtures/<id>.json, and the sample's own check must pass before anything is saved.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_SAMPLES, recordingIO, shrink, type Recorded } from "../packages/shared/src/index";

const dir = join(import.meta.dir, "../packages/shared/fixtures");
mkdirSync(dir, { recursive: true });
const only = process.argv.slice(2);
let failed = 0;

for (const s of FIXTURE_SAMPLES.filter((x) => !only.length || only.includes(x.id))) {
  const missing = (s.needs ?? []).filter((n) => !process.env[n]?.trim());
  if (missing.length) {
    console.log(`skip  ${s.id}: set ${missing.join(", ")}`);
    continue;
  }
  const sink: Recorded[] = [];
  const io = recordingIO({ fetch: (u, i) => fetch(u, i), env: process.env, now: Date.now }, sink);
  try {
    const result = await s.run(io);
    const problem = s.check(result);
    if (problem) throw new Error(`check failed on live data: ${problem}`);
    const entries = sink.map((e) => shrink(e, s.shrink));
    writeFileSync(join(dir, `${s.id}.json`), JSON.stringify(entries));
    console.log(`saved ${s.id}: ${entries.length} response(s), ${Math.round(entries.reduce((n, e) => n + e.text.length, 0) / 1024)} KB`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${s.id}: ${(e as Error).message} (fixture not written)`);
  }
}
process.exit(failed ? 1 : 0);
