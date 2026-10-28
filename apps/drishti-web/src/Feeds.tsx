import { useEffect, useState } from "react";
import { instrument } from "@drishti/shared";
import { apiUrl, streamHttpUrl, useClock } from "./settings";
import { Button, Select } from "./ui";

interface Health {
  feed: "live" | "demo";
  providers: Record<string, { ok: number; failed: number; lastError: string | null; lastOkAt: number | null }>;
  active: Record<string, string>;
  mcxPrimary?: "upstox" | "tradingview" | "auto";
}
interface UpstoxStatus {
  configured: boolean;
  loginConfigured: boolean;
  via: "login" | "env" | null;
  connected: boolean;
  expiresAt: number | null;
}

/** Poll a JSON endpoint while mounted (Settings dialog open). */
export function usePoll<T>(url: string, ms: number) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((d) => alive && setData(d));
    load();
    const id = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [url, ms]);
  return data;
}

const ago = (t: number | null) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago` : "never");

/** Settings → Connection: Upstox login state and per-provider health from the stream service. */
export function Feeds() {
  const upstox = usePoll<UpstoxStatus>(`${apiUrl()}/auth/upstox/status`, 10_000);
  const health = usePoll<Health>(streamHttpUrl("/health"), 3_000);
  const account = usePoll<{ access: string; hint: string }>(`${apiUrl()}/auth/upstox/account`, 60_000); // can the app read your account? (needs the static IP registered in Upstox)
  const clock = useClock();
  const [primary, setPrimary] = useState<string | null>(null); // optimistic: shown until the next health poll agrees
  const setMcxPrimary = (source: string) => {
    setPrimary(source);
    fetch(streamHttpUrl("/primary"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source }) }).catch(() => setPrimary(null));
  };

  return (
    <>
      <div className="set-grid">
      <div className="field">
        <span>
          Upstox (MCX real-time)
          <small className="muted">
            {!upstox
              ? "API unreachable"
              : !upstox.configured
                ? "add UPSTOX_ACCESS_TOKEN, or UPSTOX_API_KEY / SECRET / REDIRECT_URI, to .env"
                : upstox.via === "login"
                  ? `connected (login) until ${clock.time(upstox.expiresAt!)}`
                  : upstox.via === "env"
                    ? "using UPSTOX_ACCESS_TOKEN from .env (see feed health below if it's rejected)"
                    : "not connected: MCX uses TradingView fallback"}
          </small>
        </span>
        <Button
          variant="default"
          disabled={!upstox?.loginConfigured}
          title={upstox?.loginConfigured ? undefined : "Login needs UPSTOX_API_KEY / SECRET / REDIRECT_URI in .env"}
          onClick={() => window.open(`${apiUrl()}/auth/upstox/login`, "_blank", "noopener")}
        >
          {upstox?.via === "login" ? "Reconnect" : "Connect Upstox"}
        </Button>
      </div>

      {upstox?.connected && (
        <div className="field">
          <span>
            Upstox account (positions, funds, trades)
            <small className="muted">{account ? account.hint : "checking…"}</small>
          </span>
          <span className={account?.access === "ok" ? "badge up" : "badge"} title="Market data works with any valid token; the account endpoints answer only from the static IP registered in your Upstox app.">
            {account?.access === "ok" ? "readable" : account?.access === "static_ip" ? "needs static IP" : account?.access === "token" ? "refused" : "unavailable"}
          </span>
        </div>
      )}

      <div className="field wide">
        <span>
          MCX primary source
          <small className="muted">Preferred feed for MCX prices; the other takes over if it goes quiet for 15 s</small>
        </span>
        <Select aria-label="MCX primary source" value={primary ?? health?.mcxPrimary ?? "auto"} disabled={!health} onChange={(e) => setMcxPrimary(e.target.value)}>
          <option value="auto">Auto (Upstox, then TradingView)</option>
          <option value="tradingview">TradingView first</option>
          <option value="upstox">Upstox first</option>
        </Select>
      </div>
      </div>

      {health?.feed === "demo" && <p className="hint down">Demo feed (FEED=demo): prices are simulated.</p>}
      <div className="set-cards">
      {health &&
        Object.entries(health.providers).map(([name, p]) => (
          <div className="field" key={name}>
            <span>
              {name}
              <small className="muted">
                last ok {ago(p.lastOkAt)} · {p.ok} ok / {p.failed} failed
                {p.lastError && ` · ${p.lastError}`}
              </small>
            </span>
            <span className="muted">
              {Object.entries(health.active)
                .filter(([, src]) => src === name)
                .map(([sym]) => instrument(sym)?.symbol.split(":")[1])
                .join(", ") || "standby"}
            </span>
          </div>
        ))}
      </div>
      {!health && <p className="hint muted">Stream service unreachable.</p>}
    </>
  );
}
