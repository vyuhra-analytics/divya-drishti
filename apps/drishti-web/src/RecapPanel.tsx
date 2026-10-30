import { useCallback, useEffect, useState } from "react";
import { buildRecap, instrument, recapExtras, type CotRow, type CurveSummary, type EiaSummary, type Recap } from "@drishti/shared";
import { gatherContext } from "./BriefingPanel";
import { apiUrl, useClock } from "./settings";
import { useWidgetSymbol, type Widget } from "./workspace";

const REFRESH_MS = 60_000;

const get = async <T,>(path: string): Promise<T | undefined> => {
  try {
    const res = await fetch(`${apiUrl()}${path}`);
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
};

/** Plain-language recap of the linked instrument, built from fixed templates over live numbers: no AI, no key. */
export function RecapWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const clock = useClock();
  const [recap, setRecap] = useState<{ at: number; value: Recap } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const inst = instrument(symbol);
    if (inst?.exchange === "FX" || inst?.exchange === "NSE") return setError("The recap covers the energy futures: pick an MCX or NYMEX contract."); // no curve, COT or inventories for a currency
    const crude = inst?.topic === "crude";
    try {
      const [ctx, curve, cot, eia] = await Promise.all([
        gatherContext(symbol, "5m"),
        get<{ summary?: CurveSummary }>(`/curve?symbol=${encodeURIComponent(symbol)}`),
        get<{ rows: CotRow[] }>(`/cot?market=${crude ? "wti" : "natgas"}&weeks=156`),
        crude ? get<{ series: (EiaSummary & { label: string })[] }>("/eia") : Promise.resolve(undefined),
      ]);
      setRecap({ at: Date.now(), value: buildRecap(ctx, recapExtras({ crude, curve, cot, eia })) });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [symbol]);

  useEffect(() => {
    setRecap(null);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="recap">
      <div className="recap-body" tabIndex={0} role="region" aria-label="Energy recap">
        {error && !recap && <p className="empty muted">{error}</p>}
        {!recap && !error && <p className="empty muted">Building recap…</p>}
        {recap && (
          <>
            <p className="recap-head">{recap.value.headline}</p>
            <ul>
              {recap.value.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
            <p className="muted recap-note">
              Built from fixed templates over live numbers (no AI), updated {clock.time(recap.at)}. Positioning is weekly and EIA stocks are for the latest reported week.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
