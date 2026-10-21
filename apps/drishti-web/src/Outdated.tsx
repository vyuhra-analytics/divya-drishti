import { FRESHNESS_BUDGET_MS, withinBudget, type DataKind } from "@drishti/shared";

/** Shown next to data older than its freshness budget (a missed weekly release, a source that stopped updating). Nothing when it is current. */
export function Outdated({ kind, asOf, now = Date.now() }: { kind: DataKind; asOf: number; now?: number }) {
  if (withinBudget(kind, asOf, now)) return null;
  const days = Math.round(FRESHNESS_BUDGET_MS[kind] / 86_400_000);
  const age = Math.round((now - asOf) / 86_400_000);
  return (
    <span className="badge stale" title={`This data is ${age} days old; ${kind} data is normally no older than ${days} days. The source may have missed an update.`}>
      OUTDATED
    </span>
  );
}
