// Draw a seeded, stratified sample of crude headlines into `gold_sample` for hand labelling (research/sentiment/LABELLING.md).
//   bun --env-file=.env research/sentiment/make-gold-sample.ts --source=news|gdelt [--n=200] [--seed=1]
// Stratified by the sign of the crude word list (bullish, bearish, no word) so every kind turns up, which is recorded for the record and never shown to a
// labeler. Headlines already sampled are skipped, so a second run adds new ones. The seed makes a draw repeatable.
import { SQL } from "bun";
import { crudeTone } from "../../packages/shared/src/crudeLexicon";
import { rng } from "../../packages/shared/src/sentimentStudy";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const source = arg("source");
if (source !== "news" && source !== "gdelt") throw new Error("--source must be news or gdelt");
const n = Math.min(2000, Math.max(3, Number(arg("n") ?? 200)));
const seed = Number(arg("seed") ?? 1);

const sql = new SQL(process.env.DATABASE_URL!);
const rows =
  source === "news"
    ? ((await sql`SELECT id AS ref, title, source AS outlet, published_at FROM news WHERE 'crude' = ANY(tags) OR 'oil' = ANY(tags)`) as { ref: string; title: string; outlet: string; published_at: Date }[])
    : ((await sql`SELECT key AS ref, title, source AS outlet, seen_at AS published_at FROM gdelt_headlines`) as { ref: string; title: string; outlet: string; published_at: Date }[]);
const taken = new Set(((await sql`SELECT ref FROM gold_sample WHERE source = ${source}`) as { ref: string }[]).map((r) => r.ref));
const rand = rng(seed);
const shuffle = <T>(a: T[]) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const strata: Record<string, typeof rows> = { bullish: [], bearish: [], none: [] };
for (const r of rows) {
  if (taken.has(r.ref) || r.title.length < 15) continue;
  const t = crudeTone(r.title).tone;
  strata[t > 0 ? "bullish" : t < 0 ? "bearish" : "none"].push(r);
}
for (const k of Object.keys(strata)) shuffle(strata[k]);
const picked: { r: (typeof rows)[number]; stratum: string }[] = [];
const per = Math.ceil(n / 3);
for (const k of ["bullish", "bearish", "none"]) for (const r of strata[k].slice(0, per)) picked.push({ r, stratum: k });
const rest = shuffle(["bullish", "bearish", "none"].flatMap((k) => strata[k].slice(per).map((r) => ({ r, stratum: k }))));
while (picked.length < n && rest.length) picked.push(rest.pop()!);
const chosen = shuffle(picked).slice(0, n);
for (const { r, stratum } of chosen)
  await sql`INSERT INTO gold_sample (source, ref, title, outlet, published_at, stratum) VALUES (${source}, ${r.ref}, ${r.title}, ${r.outlet}, ${new Date(r.published_at).toISOString()}, ${stratum}) ON CONFLICT (source, ref) DO NOTHING`;
const [{ total }] = (await sql`SELECT count(*)::int AS total FROM gold_sample`) as { total: number }[];
console.log(`${chosen.length} ${source} headlines added (seed ${seed}); gold_sample holds ${total}. Candidates by stratum: ${Object.entries(strata).map(([k, v]) => `${k} ${v.length}`).join(", ")}`);
await sql.close();
