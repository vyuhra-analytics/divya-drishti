// Tidy the database: `bun run db:clean` shows what it would remove, `bun run db:clean -- --apply` removes it.
// Only things nobody reads: the audit trail of the throwaway accounts that `bun run e2e` and `bun run smoke` create, prices and candles of
// instruments that are no longer tracked, and option open-interest snapshots older than a week (the chain needs only the previous day).
// Your own paper accounts, trades, alerts and every tracked symbol's data are never touched.
import { SQL } from "bun";
import { INSTRUMENTS } from "../packages/shared/src/index";

const APPLY = process.argv.includes("--apply");
const TEST_ACCOUNTS = ["e2e", "smoke"];
const OI_KEEP_DAYS = 7;

const sql = new SQL(process.env.DATABASE_URL!);
// no .catch: if the list of added instruments cannot be read, stop rather than treat their data as orphaned
const custom = ((await sql`SELECT symbol FROM custom_instruments`) as { symbol: string }[]).map((r) => r.symbol);
const tracked = [...INSTRUMENTS.filter((i) => !i.custom).map((i) => i.symbol), ...custom];

const count = async (q: Promise<unknown>) => Number(((await q) as { n: string | number }[])[0]!.n);
const steps: { what: string; n: number; table?: string; run: () => Promise<unknown> }[] = [
  {
    what: `audit rows of the test accounts (${TEST_ACCOUNTS.join(", ")})`,
    n: await count(sql`SELECT count(*) AS n FROM paper_audit WHERE account IN ${sql(TEST_ACCOUNTS)}`),
    run: () => sql`DELETE FROM paper_audit WHERE account IN ${sql(TEST_ACCOUNTS)}`,
  },
  ...(["candles", "ticks", "rolls"] as const).map((table) => ({
    what: `${table} of symbols that are no longer tracked`,
    n: 0, // counted below
    table,
    run: () => sql`DELETE FROM ${sql(table)} WHERE symbol NOT IN ${sql(tracked)}`,
  })),
  {
    what: `option OI snapshots older than ${OI_KEEP_DAYS} days`,
    n: await count(sql`SELECT count(*) AS n FROM option_oi WHERE day < current_date - ${OI_KEEP_DAYS}::int`),
    run: () => sql`DELETE FROM option_oi WHERE day < current_date - ${OI_KEEP_DAYS}::int`,
  },
];
for (const s of steps) if (s.table) s.n = await count(sql`SELECT count(*) AS n FROM ${sql(s.table)} WHERE symbol NOT IN ${sql(tracked)}`);

console.log(`${APPLY ? "Removing" : "Would remove (dry run, add --apply)"}:`);
for (const s of steps) {
  console.log(`  ${String(s.n).padStart(7)}  ${s.what}`);
  if (APPLY && s.n > 0) await s.run();
}
const [{ n: ticks }] = (await sql`SELECT count(*) AS n FROM ticks WHERE time < now() - interval '30 days'`) as { n: string }[];
if (Number(ticks) > 0) console.log(`Note: ${ticks} ticks are older than 30 days (kept: there is no tick retention policy yet).`);
await sql.close();
