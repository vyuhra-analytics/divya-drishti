import { agreement, instrument, SYMBOLS, type CanaryResult, type CanaryStatus, type SourcePrices } from "@drishti/shared";
import { usePoll } from "./Feeds";
import { apiUrl, streamHttpUrl, useClock } from "./settings";
import { useNow } from "./market";
import type { Widget } from "./workspace";

interface Health {
  providers: Record<string, { ok: number; failed: number; lastError: string | null; lastOkAt: number | null; latencyMs?: number | null }>;
  active: Record<string, string>;
  prices?: Record<string, SourcePrices>;
  rejected?: { count: number; last?: { symbol: string; source: string; reason: string; at: number } };
}
type Canary = CanaryResult & { recent: { at: number; status: CanaryStatus }[] };

const DOT: Record<CanaryStatus, string> = { ok: "dq-ok", unreachable: "dq-bad", format: "dq-bad", skipped: "dq-skip" };
const LABEL: Record<CanaryStatus, string> = { ok: "OK", unreachable: "UNREACHABLE", format: "FORMAT CHANGED", skipped: "SKIPPED" };

const age = (ms: number) => (ms < 1000 ? "now" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3600_000)}h`);

/** Data-quality console: are the live feeds alive, do they agree with each other, and does every outside source still parse? */
export function QualityWidget(_: { widget: Widget }) {
  const health = usePoll<Health>(streamHttpUrl("/health"), 3_000);
  const canaries = usePoll<{ canaries: Canary[] }>(`${apiUrl()}/canaries`, 30_000);
  const now = useNow(5_000);
  const clock = useClock();
  const feeds = health ? Object.entries(health.providers) : [];
  const fresh = (t: number | null) => (t === null ? "never" : age(Math.max(0, now - t)));
  const live = (t: number | null) => t !== null && now - t < 60_000;

  return (
    <div className="dq">
      <div className="dq-body" tabIndex={0} role="region" aria-label="Data quality">
        <h2>Live feeds</h2>
        {!health && <p className="muted">Stream service unreachable.</p>}
        {health && (
          <table>
            <thead>
              <tr>
                <th>Feed</th>
                <th>Status</th>
                <th>Last ok</th>
                <th>Latency</th>
                <th>OK / failed</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {feeds.map(([name, p]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td className={live(p.lastOkAt) ? "up" : "down"}>{live(p.lastOkAt) ? "live" : p.lastOkAt === null ? "never heard" : "silent"}</td>
                  <td className="muted">{fresh(p.lastOkAt)}</td>
                  <td className="muted">{p.latencyMs ? `${p.latencyMs} ms` : "—"}</td>
                  <td className="muted">
                    {p.ok} / {p.failed}
                  </td>
                  <td className="muted dq-err" title={p.lastError ?? undefined}>
                    {p.lastError ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {health?.rejected && health.rejected.count > 0 && (
          <p className="down dq-note">
            {health.rejected.count} impossible quote(s) rejected; last: {health.rejected.last?.source} {health.rejected.last?.symbol}, {health.rejected.last?.reason}.
          </p>
        )}

        <h2>Price agreement between feeds</h2>
        {health?.prices && (
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Feeds heard in the last minute</th>
                <th>Gap</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {SYMBOLS.map((symbol) => {
                const a = agreement(symbol, health.prices?.[symbol] ?? {}, now);
                const d = instrument(symbol)?.decimals ?? 2;
                return (
                  <tr key={symbol}>
                    <td>{symbol.split(":")[1]}</td>
                    <td className="muted">
                      {a.sources.length === 0
                        ? "none"
                        : a.sources.map((s) => `${s.source} ${s.price.toFixed(d)}${health.active[symbol] === s.source ? " (shown)" : ""}`).join("  ·  ")}
                    </td>
                    <td>{a.gap ? `${a.gap.points.toFixed(d)} (${a.gap.ticks} tick${a.gap.ticks === 1 ? "" : "s"}, ${a.gap.pct.toFixed(3)}%)` : <span className="muted">one feed only</span>}</td>
                    <td className={a.drifting ? "down" : "up"}>{a.drifting ? "DRIFTING" : a.gap ? "agree" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted dq-note">Compared only between feeds with the same delay. A large gap usually means a stale feed or the wrong contract month.</p>

        <h2>Source checks</h2>
        {!canaries && <p className="muted">Loading checks… (the first run starts a few seconds after the API starts)</p>}
        {canaries && canaries.canaries.length === 0 && <p className="muted">No checks have run yet.</p>}
        {canaries && canaries.canaries.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Checked</th>
                <th>Time</th>
                <th>Last {canaries.canaries[0]?.recent.length ?? 0}</th>
              </tr>
            </thead>
            <tbody>
              {[...canaries.canaries]
                .sort((a, b) => Number(a.status === "ok") - Number(b.status === "ok") || a.id.localeCompare(b.id))
                .map((c) => (
                  <tr key={c.id}>
                    <td title={c.detail}>{c.id}</td>
                    <td className={c.status === "ok" ? "up" : c.status === "skipped" ? "muted" : "down"}>
                      {LABEL[c.status]}
                      {c.detail && <small className="muted"> · {c.detail}</small>}
                    </td>
                    <td className="muted" title={clock.stamp(c.at)}>
                      {age(Math.max(0, now - c.at))} ago
                    </td>
                    <td className="muted">{c.ms} ms</td>
                    <td>
                      <span className="dq-dots" aria-label={`recent results: ${c.recent.map((r) => r.status).join(", ")}`}>
                        {c.recent.map((r) => (
                          <i key={r.at} className={DOT[r.status]} title={`${r.status} at ${clock.time(r.at)}`} />
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
        <p className="muted dq-note">
          Each source's real parser runs against the live provider every hour (JODI daily). "Format changed" means the provider answered but its data no longer parses. Not checked: Upstox login, the Forex Factory calendar, SEC EDGAR and the AI service.
        </p>
      </div>
    </div>
  );
}
