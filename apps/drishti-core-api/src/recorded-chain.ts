import type { SQL } from "bun";
import { recordedChain, type Chain, type SnapshotContract } from "@drishti/shared";

/** Why no chain could be built for a moment: nothing was recorded by then, or the snapshot holds no options of that underlying. */
export type ChainMiss = "no-snapshot" | "no-options";

/**
 * The chain as our snapshots recorded it at (or just before) `at`: the latest snapshot at or before it, OI change against the first snapshot of the same IST
 * day, `each` strikes either side of the money. Shared by the chain viewer and the signal log. Database errors are thrown.
 */
export async function recordedChainAt(sql: SQL, underlying: string, expiry: string | undefined, at: number, each = 10): Promise<{ chain: Chain } | { miss: ChainMiss }> {
  const [snap] = (await sql`SELECT max(time) AS t FROM quote_snapshots WHERE time <= ${new Date(at).toISOString()}`) as { t: Date | null }[];
  if (!snap?.t) return { miss: "no-snapshot" };
  const t = new Date(snap.t);
  const istMidnight = new Date(Math.floor((t.getTime() + 5.5 * 3600_000) / 86_400_000) * 86_400_000 - 5.5 * 3600_000);
  const [[prev], [next], [first]] = (await Promise.all([
    sql`SELECT max(time) AS t FROM quote_snapshots WHERE time < ${t.toISOString()}`,
    sql`SELECT min(time) AS t FROM quote_snapshots WHERE time > ${t.toISOString()}`,
    sql`SELECT min(time) AS t FROM quote_snapshots WHERE time >= ${istMidnight.toISOString()}`,
  ])) as { t: Date | null }[][];
  const load = (when: Date) => sql`
    SELECT c.key, c.kind AS side, c.expiry::text AS expiry, c.strike, c.lot, c.raw->>'underlying_key' AS "underlyingKey",
           s.last_price AS "lastPrice", s.net_change AS "netChange", s.oi, s.volume, s.iv, s.delta, s.theta, s.gamma, s.vega,
           s.lower_circuit AS "lowerCircuit", s.upper_circuit AS "upperCircuit", s.depth
    FROM quote_snapshots s JOIN contract_master c ON c.key = s.key
    WHERE s.time = ${when.toISOString()} AND c.underlying = ${underlying}`;
  const rows = (await load(t)) as SnapshotContract[];
  const firstAt = first?.t ? new Date(first.t) : undefined;
  const baseline =
    firstAt && firstAt.getTime() < t.getTime()
      ? new Map(((await load(firstAt)) as SnapshotContract[]).flatMap((r) => (r.oi === null || r.oi === undefined ? [] : [[r.key, Number(r.oi)] as [string, number]])))
      : undefined;
  const chain = recordedChain({ underlying, expiry: expiry || undefined, asOf: t.getTime(), rows, baseline, strikesEachSide: each, prevAt: prev?.t ? new Date(prev.t).getTime() : null, nextAt: next?.t ? new Date(next.t).getTime() : null });
  return chain ? { chain } : { miss: "no-options" };
}
