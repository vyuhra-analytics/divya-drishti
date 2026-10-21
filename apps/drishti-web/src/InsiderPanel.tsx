import { useEffect, useState } from "react";
import { INSIDER_TICKERS, type InsiderTrade } from "@drishti/shared";
import { apiUrl, makeFormat, useSettings } from "./settings";
import type { Widget } from "./workspace";

const TICKERS = Object.keys(INSIDER_TICKERS);
const CODES: Record<string, string> = { P: "Buy", S: "Sell", A: "Grant", M: "Exercise", F: "Tax", G: "Gift", D: "Return" };

/** Insider transactions (SEC Form 4) of the big US energy names. */
export function InsiderWidget(_: { widget: Widget }) {
  const locale = useSettings((s) => s.locale);
  const [ticker, setTicker] = useState(TICKERS[0]);
  const [trades, setTrades] = useState<InsiderTrade[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setTrades(null);
    setError(null);
    fetch(`${apiUrl()}/insider?ticker=${ticker}`, { signal: ctrl.signal })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
        setTrades(json.trades);
      })
      .catch((e) => (e.name !== "AbortError" ? setError(e.message) : undefined));
    return () => ctrl.abort();
  }, [ticker]);

  const f = makeFormat(locale, 0);
  return (
    <div className="insider">
      <div className="toolbar no-drag">
        {TICKERS.map((t) => (
          <button key={t} className={t === ticker ? "tf active" : "tf"} onClick={() => setTicker(t)}>
            {t}
          </button>
        ))}
      </div>
      {error ? (
        <p className="empty muted">{error}</p>
      ) : !trades ? (
        <p className="empty muted">Loading Form 4 filings…</p>
      ) : trades.length === 0 ? (
        <p className="empty muted">No recent insider transactions.</p>
      ) : (
        <div className="insider-scroll" tabIndex={0} role="region" aria-label="Insider transactions">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Insider</th>
                <th>Type</th>
                <th>Shares</th>
                <th>Price</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => (
                <tr key={i}>
                  <td>{t.date}</td>
                  <td title={t.title}>
                    {t.owner}
                    {t.title && <small className="muted"> {t.title}</small>}
                  </td>
                  <td className={t.code === "P" ? "up" : t.code === "S" ? "down" : "muted"}>
                    <a href={t.url} target="_blank" rel="noreferrer noopener" title={`Code ${t.code}`}>
                      {CODES[t.code] ?? t.code}
                    </a>
                  </td>
                  <td>{f.volume(Math.abs(t.shares))}</td>
                  <td>{t.price === undefined ? "—" : t.price.toFixed(2)}</td>
                  <td>{t.value === undefined ? "—" : f.volume(t.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
