import { useEffect, useState } from "react";
import { STATUS_MAX_AGE_MS, type SessionState } from "@drishti/shared";
import { useNow, useSessions } from "./market";
import { formatStamp, streamHttpUrl, useSettings } from "./settings";
import { useStore } from "./store";

const CLOCKS = [
  { label: "IST", tz: "Asia/Kolkata" },
  { label: "NY", tz: "America/New_York" },
  { label: "LDN", tz: "Europe/London" },
];
const SOURCE_LABEL: Record<string, string> = { upstox: "Upstox", tradingview: "TradingView", yahoo: "Yahoo", demo: "Demo feed" };
const SOURCE_NOTE: Record<string, string> = {
  upstox: "real-time MCX prices (your Upstox login)",
  tradingview: "TradingView scanner: MCX fallback, a few seconds behind",
  yahoo: "Yahoo Finance: NYMEX prices, about 10 minutes delayed",
  demo: "simulated prices (FEED=demo)",
};

interface Health {
  providers: Record<string, { lastOkAt: number | null; failed: number; lastError: string | null }>;
  active: Record<string, string>;
}

/** Stream feed health, polled every 10 s (only the status bar uses it). */
function useHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(streamHttpUrl("/health"))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((h) => alive && setHealth(h));
    load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return health;
}

const ago = (ms: number) => (ms < 1000 ? "now" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

function Market({ name, s, locale, clock, note }: { name: string; s: SessionState; locale: string; clock: "12h" | "24h"; note?: string }) {
  const when = s.next ? formatStamp(s.next, locale, clock, "time") : "";
  return (
    <span className="sb-item" title={[s.next ? `${s.open ? "Closes" : "Opens"} ${formatStamp(s.next, locale, clock, "datetime")}` : "", note ?? ""].filter(Boolean).join(" · ") || undefined}>
      <span className={s.open ? "sb-dot open" : "sb-dot closed"} aria-hidden="true" />
      {name} <b>{s.open ? "Open" : "Closed"}</b>
      {when && <span className="muted">{s.open ? ` · closes ${when}` : ` · opens ${when}`}</span>}
    </span>
  );
}

/** Bottom status bar: exchange sessions, world clocks and live feed health. */
export function StatusBar() {
  const now = useNow(1000);
  const sessions = useSessions();
  const mcxStatus = useStore((s) => s.mcxStatus);
  const health = useHealth();
  const locale = useSettings((s) => s.locale);
  const clock = useSettings((s) => s.clock);
  // only sources currently serving something are interesting
  const serving = new Set(Object.values(health?.active ?? {}));

  return (
    <footer className="statusbar" aria-label="Market status">
      <Market name="MCX" s={sessions.MCX} locale={locale} clock={clock} note={mcxStatus && now - mcxStatus.at <= STATUS_MAX_AGE_MS ? `Exchange status from Upstox: ${mcxStatus.state}` : undefined} />
      <Market name="NYMEX" s={sessions.NYMEX} locale={locale} clock={clock} />
      <Market name="NSE" s={sessions.NSE} locale={locale} clock={clock} />
      <Market name="FX" s={sessions.FX} locale={locale} clock={clock} />
      <span className="sb-sep" aria-hidden="true" />
      {CLOCKS.map((c) => (
        <span key={c.label} className="sb-item">
          {c.label} <b>{formatStamp(now, locale, clock, "time", c.tz)}</b>
        </span>
      ))}
      <span className="sb-sep" aria-hidden="true" />
      {!health && <span className="sb-item down">Stream unreachable</span>}
      {health &&
        Object.entries(health.providers)
          .filter(([name]) => serving.has(name))
          .map(([name, p]) => {
            const age = p.lastOkAt ? now - p.lastOkAt : Infinity;
            const ok = age < 60_000; // same window as the STALE rule; quiet feeds (closed market) only send on trades
            return (
              <span key={name} className="sb-item" title={`${SOURCE_LABEL[name] ?? name}: ${SOURCE_NOTE[name] ?? "price feed"}. ${p.lastError ? `Last error: ${p.lastError}` : `Last update ${ago(age)} ago.`}`}>
                <span className={ok ? "sb-dot open" : "sb-dot stale"} aria-hidden="true" />
                {SOURCE_LABEL[name] ?? name} <span className="muted">{Number.isFinite(age) ? ago(age) : "—"}</span>
              </span>
            );
          })}
    </footer>
  );
}
