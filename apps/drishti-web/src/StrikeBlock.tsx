import { useEffect, useMemo } from "react";
import { DAY_RULES, nearestWalls, type Chain, type DaySide, type StrikeSuggestion } from "@drishti/shared";
import { sendWatch, useStore } from "./store";

// The option to buy, for the report-day and USIB panels: five strikes around the money with premium, delta, theta, IV, OI and volume, the pick with its
// cost for one lot and 1R in rupees, and the nearest open-interest walls. The premiums are the LIVE option quotes (the stream is asked to watch the five
// strikes' contracts) laid over the polled chain; a quote older than 10 seconds is not shown as live, so a silent feed falls back to the poll by itself.

const num = (v: number | undefined, dp = 1) => (v === undefined ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const rs = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;
const LIVE_MS = 10_000;

export function StrikeBlock({ strike, chain, side, price }: { strike: StrikeSuggestion; chain: Chain | null | undefined; side?: DaySide; price?: number }) {
  const options = useStore((s) => s.options);
  const keys = useMemo(() => strike.rows.map((r) => r.leg?.ukey).filter((k): k is string => !!k), [strike.rows]);
  useEffect(() => {
    if (!keys.length) return;
    sendWatch(keys);
    const id = setInterval(() => sendWatch(keys), 20_000);
    return () => clearInterval(id);
  }, [keys.join(",")]);

  const walls = nearestWalls(chain, price);
  const now = Date.now();
  let live = 0;
  return (
    <section>
      <h2>Option to buy {side ? `(${side})` : ""}</h2>
      {strike.rows.length === 0 ? (
        <p className="muted">{strike.note}</p>
      ) : (
        <>
          <table className="bt-num rd-table">
            <thead>
              <tr>
                <th>Strike</th>
                <th title="The ask, from the live option quote when one is under 10 seconds old, else from the polled chain">Premium</th>
                <th>Delta</th>
                <th>Theta</th>
                <th>IV</th>
                <th>OI</th>
                <th>Vol</th>
              </tr>
            </thead>
            <tbody>
              {strike.rows.map((r) => {
                const l = r.leg;
                const q = l?.ukey ? options[l.ukey] : undefined;
                const fresh = q !== undefined && now - q.recvAt < LIVE_MS;
                const p = fresh ? (q.ask && q.ask > 0 ? q.ask : q.price) : l?.ask && l.ask > 0 ? l.ask : l?.ltp;
                if (fresh) live++;
                return (
                  <tr key={r.strike} className={strike.pick?.strike === r.strike ? "next" : ""}>
                    <td>
                      {r.strike} {r.atm && <small className="muted">ATM</small>}
                    </td>
                    <td>
                      {num(p, 1)} {fresh && <small className="up" title="live option quote">●</small>}
                    </td>
                    <td>{num(l?.delta, 2)}</td>
                    <td>{num(l?.theta, 1)}</td>
                    <td>{num(l?.iv, 1)}</td>
                    <td>{l?.oi?.toLocaleString("en-IN") ?? "—"}</td>
                    <td>{l?.volume?.toLocaleString("en-IN") ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className={strike.pick ? "" : "down"}>
            {strike.pick ? (
              <>
                <b>
                  {strike.pick.strike} {strike.pick.side === "long" ? "CE" : "PE"}
                </b>{" "}
                at {num(strike.pick.premium, 1)} = {rs(strike.pick.cost)} for one lot (capital {rs(DAY_RULES.capital)})
                {strike.pick.rupeeR !== undefined && <> · 1R ≈ {rs(strike.pick.rupeeR)} (cap {rs(DAY_RULES.lossCap)})</>}
              </>
            ) : (
              strike.note
            )}
          </p>
          {strike.pick && <p className="muted">{strike.note}</p>}
          <p className="muted rd-walls">
            Open-interest walls: {walls.call ? `calls ${walls.call.strike} (${walls.call.oi.toLocaleString("en-IN")})` : "no call wall"} above · {walls.put ? `puts ${walls.put.strike} (${walls.put.oi.toLocaleString("en-IN")})` : "no put wall"} below
            {strike.rows.length > 0 && <> · {live > 0 ? `${live} of ${strike.rows.length} premiums live` : "premiums from the poll"}</>}
          </p>
        </>
      )}
    </section>
  );
}
