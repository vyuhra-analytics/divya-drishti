import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ACCOUNT_ID, instrument, lotUnits, tickSize, unrealisedNet, type FillDetail, type PaperTrade, type Side } from "@drishti/shared";
import { paperCall, usePaperAccount } from "./paperClient";
import { PaperOptionTicket } from "./PaperOptionTicket";
import { useFreshness } from "./market";
import { useClock, useSettings } from "./settings";
import { sendWatch, useStore } from "./store";
import { useWidgetSymbol, type Widget } from "./workspace";
import { Button, Input, Select } from "./ui";

const REASON = { manual: "Closed by hand", stop: "Stop hit", target: "Target hit", expired: "Expired, settled at the last premium", time: "Time exit" } as const;
const ACCOUNT_KEY = "drishti-paper-account";
const LEGACY_KEY = "drishti-paper"; // the account this browser kept before paper trading moved to the server
const IMPORTED_KEY = "drishti-paper-imported";

const remembered = () => {
  try {
    return localStorage.getItem(ACCOUNT_KEY) || "main";
  } catch {
    return "main";
  }
};
/** "USIB · usib-1": the strategy and tag an order carried, when it carried any. */
const labels = (x: { strategy?: string; tag?: string }) => [x.strategy, x.tag].filter(Boolean).join(" · ");
/** One line saying how a fill was priced: which side of the book, which feed, and the slippage. */
const fillText = (side: "entry" | "exit", f?: FillDetail) =>
  f ? `${side === "entry" ? "Entry" : "Exit"}: ${f.reference} from ${f.quote.source ?? "the feed"}${f.quote.bid !== undefined && f.quote.ask !== undefined ? ` (bid ${f.quote.bid}, ask ${f.quote.ask})` : ""}, ${f.slippageTicks} tick${f.slippageTicks === 1 ? "" : "s"} slippage, filled ${f.price}` : "";

const who = (actor?: string) => (actor === "mcp" ? "Claude (MCP)" : actor === "engine" ? "stop/target" : "you");

/**
 * Paper trading, simulated, on the server: the account lives in Postgres and the stream service fills orders on live quotes, so a trade
 * placed here, in another tab, or by an agent over MCP is the same account everywhere and shows up within a second. Never sent to a broker.
 */
export function PaperWidget({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const inst = instrument(symbol);
  const locale = useSettings((s) => s.locale);
  const clock = useClock();
  const [ticket, setTicket] = useState<"futures" | "options">("futures");
  const fresh = useFreshness(symbol);
  const [accountId, setAccountId] = useState(remembered);
  const { state, accounts, error, reload } = usePaperAccount(accountId);
  const [side, setSide] = useState<Side>("buy");
  const [lots, setLots] = useState(1);
  const [entry, setEntry] = useState("");
  const [taken, setTaken] = useState(false);
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [newId, setNewId] = useState("");

  const pick = (id: string) => {
    setAccountId(id);
    try {
      localStorage.setItem(ACCOUNT_KEY, id);
    } catch {
      /* not remembered */
    }
  };

  // one-time move of the account this browser kept before paper trading lived on the server (only into an empty server account)
  useEffect(() => {
    if (!state || accountId !== "main" || state.positions.length || state.trades.length) return;
    try {
      if (localStorage.getItem(IMPORTED_KEY)) return;
      const old = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "null")?.state;
      if (!old || (!old.trades?.length && !old.positions?.length)) return;
      void paperCall<{ positions: number; trades: number }>("/accounts/main/import", "POST", old).then((r) => {
        localStorage.setItem(IMPORTED_KEY, "1");
        if (r.ok) {
          setMsg(`Imported ${r.data.trades} trades and ${r.data.positions} open positions from this browser to the server.`);
          void reload();
        }
      });
    } catch {
      /* nothing to import */
    }
  }, [state, accountId, reload]);

  const nf = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), [locale]);
  const rs = (v: number) => `${v < 0 ? "−" : ""}₹${nf.format(Math.abs(v))}`;
  const px = (s: string, v: number) => v.toFixed(instrument(s)?.decimals ?? 2);
  // only the quotes this panel shows (the linked contract and the futures positions): the whole quotes map changes on every tick of every instrument
  const futuresKeys = [symbol, ...[...(state?.positions ?? []), ...(state?.pending ?? [])].filter((p) => !p.option).map((p) => p.symbol)];
  const quotes = useStore(useShallow((s) => Object.fromEntries(futuresKeys.map((k) => [k, s.quotes[k]]))));
  const last = quotes[symbol]?.price;
  const mcx = inst?.exchange === "MCX" && lotUnits(symbol) !== undefined;

  // open P&L is marked at the live quotes this browser already receives, so it ticks without asking the server
  // only the quotes of the option positions that are open: reading the whole options map would redraw this panel on every option tick of every contract
  const heldOptionKeys = [...(state?.positions ?? []), ...(state?.pending ?? [])].filter((p) => p.option).map((p) => p.symbol);
  const optionQuotes = useStore(useShallow((s) => Object.fromEntries(heldOptionKeys.map((k) => [k, s.options[k]]))));
  const opens = (state?.positions ?? []).map((p) => {
    const oq = p.option ? optionQuotes[p.symbol] : undefined;
    // a bid or ask of zero means nobody is quoting that side: left out, so a mark falls back to the last price
    const q = p.option ? (oq ? { price: oq.price, ...(oq.bid && oq.bid > 0 ? { bid: oq.bid } : {}), ...(oq.ask && oq.ask > 0 ? { ask: oq.ask } : {}) } : undefined) : quotes[p.symbol];
    return { p, q, net: q && state ? unrealisedNet(p, q, state.account.slippage * (p.option?.tick ?? tickSize(p.symbol)), state.rates) : 0 };
  });
  // the stream drops an option contract nobody asked for in 60 s: keep the open ones watched so their premiums and P&L tick
  const optionKeys = (state?.positions ?? []).filter((p) => p.option).map((p) => p.symbol).join(",");
  useEffect(() => {
    if (!optionKeys) return;
    const keys = optionKeys.split(",");
    sendWatch(keys);
    const id = setInterval(() => sendWatch(keys), 20_000);
    return () => clearInterval(id);
  }, [optionKeys]);
  const unrealised = opens.reduce((s, o) => s + o.net, 0);
  const sum = state?.summary;
  const equity = state && sum ? state.account.capital + sum.realised + unrealised : undefined;

  const run = async (fn: () => ReturnType<typeof paperCall>) => {
    const r = await fn();
    setMsg(r.ok ? null : r.error);
    void reload();
    return r.ok;
  };
  const submit = async () => {
    const ok = await run(() => paperCall(`/accounts/${accountId}/orders`, "POST", { symbol, side, lots, ...(entry !== "" ? { entry: Number(entry), ...(taken ? { filled: true } : {}) } : {}), ...(stop !== "" ? { stop: Number(stop) } : {}), ...(target !== "" ? { target: Number(target) } : {}) }));
    if (ok) {
      setEntry("");
      setTaken(false);
      setStop("");
      setTarget("");
    }
  };

  return (
    <div className="paper">
      <div className="paper-body" tabIndex={0} role="region" aria-label="Paper trading">
        <div className="paper-top no-drag">
          <label>
            Account
            <Select value={accountId} onChange={(ev) => pick(ev.target.value)}>
              {[...new Set([accountId, ...accounts.map((a) => a.id)])].map((id) => (
                <option key={id}>{id}</option>
              ))}
            </Select>
          </label>
          <span className="muted paper-state">Server account: also moved by Claude over MCP and by stops. Simulated, nothing reaches a broker.</span>
        </div>
        {error && <p className="down">{error}</p>}
        {!state && !error && <p className="muted">Loading paper account…</p>}

        {state && sum && equity !== undefined && (
          <>
            <div className="paper-acct">
              <div>
                <span className="muted">Equity</span>
                <strong>{rs(equity)}</strong>
              </div>
              <div>
                <span className="muted">Realised</span>
                <strong className={sum.realised >= 0 ? "up" : "down"}>{rs(sum.realised)}</strong>
              </div>
              <div>
                <span className="muted">Open</span>
                <strong className={unrealised >= 0 ? "up" : "down"}>{rs(unrealised)}</strong>
              </div>
              <div title="Brokerage, CTT, exchange, SEBI, stamp duty and GST on closed trades">
                <span className="muted">Costs paid</span>
                <strong>{rs(sum.costsPaid)}</strong>
              </div>
            </div>

            <h2>Order ticket</h2>
            <div className="toolbar no-drag" role="group" aria-label="Ticket type">
              <Button variant={ticket === "futures" ? "default" : "ghost"} size="sm" onClick={() => setTicket("futures")}>
                Futures
              </Button>
              <Button variant={ticket === "options" ? "default" : "ghost"} size="sm" onClick={() => setTicket("options")}>
                Options (buy)
              </Button>
            </div>
            {ticket === "options" ? (
              <PaperOptionTicket onOrder={(body) => run(() => paperCall(`/accounts/${accountId}/orders`, "POST", body))} />
            ) : !mcx ? (
              <p className="muted">Link this panel to an MCX contract to place a paper order (costs follow Upstox's MCX schedule).</p>
            ) : (
              <>
                <div className="costs-form no-drag">
                  <label>
                    Side
                    <Select value={side} onChange={(ev) => setSide(ev.target.value as Side)}>
                      <option value="buy">Buy (long)</option>
                      <option value="sell">Sell (short)</option>
                    </Select>
                  </label>
                  <label>
                    Lots
                    <Input type="number" min={1} step={1} value={lots} onChange={(ev) => setLots(Math.max(1, Math.floor(Number(ev.target.value) || 1)))} />
                  </label>
                  <label title="Leave it empty to trade at the current price. Type a price to place a limit order: it waits until the market reaches that price (a buy when the ask is at or under it, a sell when the bid is at or over it), for up to 24 hours.">
                    Entry (empty = current price)
                    <Input type="number" step="any" value={entry} placeholder={last === undefined ? "current price" : px(symbol, side === "buy" ? (quotes[symbol]?.ask ?? last) : (quotes[symbol]?.bid ?? last))} onChange={(ev) => setEntry(ev.target.value)} />
                  </label>
                  {entry !== "" && (
                    <label title="Tick this when you already took the trade at this price: it opens at once at exactly that price, so you can follow its profit and loss. Leave it off for a limit order that waits for the market.">
                      <input type="checkbox" checked={taken} onChange={(ev) => setTaken(ev.target.checked)} /> Already taken at this price
                    </label>
                  )}
                  <label>
                    Stop (optional)
                    <Input type="number" step="any" value={stop} placeholder={last === undefined ? "" : px(symbol, last * (side === "buy" ? 0.995 : 1.005))} onChange={(ev) => setStop(ev.target.value)} />
                  </label>
                  <label>
                    Target (optional)
                    <Input type="number" step="any" value={target} placeholder={last === undefined ? "" : px(symbol, last * (side === "buy" ? 1.01 : 0.99))} onChange={(ev) => setTarget(ev.target.value)} />
                  </label>
                </div>
                <Button variant="default" size="sm" onClick={submit}>
                  {entry !== "" ? `${taken ? "Record" : "Place limit"} ${side === "buy" ? "buy" : "sell"} ${lots} lot${lots === 1 ? "" : "s"} ${inst!.name} at ${entry}` : `${side === "buy" ? "Buy" : "Sell"} ${lots} lot${lots === 1 ? "" : "s"} ${inst!.name} at market${last === undefined ? "" : ` (${px(symbol, last)})`}`}
                </Button>
                {fresh !== "live" && <span className="muted paper-state"> · market {fresh}: orders wait for a live price</span>}
              </>
            )}
            {msg && <p className="down">{msg}</p>}

            {(state.pending?.length ?? 0) > 0 && (
              <>
                <h2>
                  Waiting orders <small className="muted">· limit orders fill when the market reaches their price, or are cancelled after 24 hours</small>
                </h2>
                <table>
                  <thead>
                    <tr>
                      <th>Contract</th>
                      <th>Order</th>
                      <th>Lots</th>
                      <th>Limit</th>
                      <th>Now</th>
                      <th>Stop / target</th>
                      <th>Placed</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(state.pending ?? []).map((o) => {
                      const nowQ = o.option ? optionQuotes[o.symbol] : quotes[o.symbol];
                      const ref = nowQ ? (o.side === "buy" ? (nowQ.ask && nowQ.ask > 0 ? nowQ.ask : nowQ.price) : (nowQ.bid && nowQ.bid > 0 ? nowQ.bid : nowQ.price)) : undefined;
                      return (
                        <tr key={o.id}>
                          <td>{o.option ? o.option.label : o.symbol.split(":")[1]}</td>
                          <td>{o.option ? "Buy limit" : o.side === "buy" ? "Buy limit" : "Sell limit"}</td>
                          <td>{o.lots}</td>
                          <td>{px(o.symbol, o.entry)}</td>
                          <td className="muted">{ref === undefined ? "—" : px(o.symbol, ref)}</td>
                          <td className="muted">
                            {o.stop === undefined ? "—" : px(o.symbol, o.stop)} / {o.target === undefined ? "—" : px(o.symbol, o.target)}
                          </td>
                          <td className="muted">{clock.stamp(o.createdAt)}</td>
                          <td>
                            <Button size="sm" onClick={() => run(() => paperCall(`/accounts/${accountId}/orders/${o.id}`, "DELETE"))}>
                              Cancel
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}

            <h2>Open positions</h2>
            {opens.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Side</th>
                    <th>Lots</th>
                    <th>Entry</th>
                    <th>Now</th>
                    <th>Stop / target</th>
                    <th title="Net of exit costs">P&amp;L</th>
                    <th>By</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {opens.map(({ p, q, net }) => (
                    <tr key={p.id}>
                      <td title={p.option ? `${p.option.label}, expires ${p.option.expiry}` : undefined}>{p.option ? p.option.label : p.symbol.split(":")[1]}</td>
                      <td>{p.option ? "Bought" : p.side === "buy" ? "Long" : "Short"}</td>
                      <td>{p.lots}</td>
                      <td>{px(p.symbol, p.entry)}</td>
                      <td>{q ? px(p.symbol, q.price) : "—"}{p.option && q && q.bid !== undefined ? <small className="muted"> bid {px(p.symbol, q.bid)}</small> : null}</td>
                      <td className="muted">
                        {p.stop === undefined ? "—" : px(p.symbol, p.stop)} / {p.target === undefined ? "—" : px(p.symbol, p.target)}
                      </td>
                      <td className={net >= 0 ? "up" : "down"}>{rs(net)}</td>
                      <td className={p.actor === "mcp" ? "paper-agent" : "muted"} title={fillText("entry", p.fill) || undefined}>
                        {who(p.actor)}
                        {labels(p) && <small className="muted paper-labels"> {labels(p)}</small>}
                      </td>
                      <td>
                        <Button size="sm" onClick={() => run(() => paperCall(`/accounts/${accountId}/positions/${p.id}/close`, "POST"))}>
                          Close
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h2>
              Journal{" "}
              <small className="muted">
                · {sum.trades} trades, win rate {(sum.winRate * 100).toFixed(0)}%, worst drawdown {rs(sum.maxDrawdown)}
              </small>
            </h2>
            {state.trades.length === 0 ? (
              <p className="muted">Closed trades appear here with their gross-to-net costs.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Closed</th>
                    <th>Trade</th>
                    <th>Gross</th>
                    <th>Costs</th>
                    <th>Net</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {state.trades.slice(0, 30).map((t) => (
                    <TradeRow key={t.id} t={t} px={px} rs={rs} stamp={clock.stamp} onNote={(note) => paperCall(`/accounts/${accountId}/trades/${t.id}/note`, "PUT", { note })} />
                  ))}
                </tbody>
              </table>
            )}

            <details>
              <summary>Account settings</summary>
              <div className="costs-form no-drag">
                <label>
                  Starting capital (₹)
                  <Input key={`c${state.account.capital}`} type="number" min={0} step={10000} defaultValue={state.account.capital} onBlur={(ev) => Number(ev.target.value) !== state.account.capital && run(() => paperCall(`/accounts/${accountId}`, "PATCH", { capital: Number(ev.target.value) }))} />
                </label>
                <label title="Ticks paid against you on every fill: one tick is ₹1 on crude and ₹0.1 on natural gas">
                  Slippage (ticks)
                  <Input key={`s${state.account.slippage}`} type="number" min={0} step="any" defaultValue={state.account.slippage} onBlur={(ev) => Number(ev.target.value) !== state.account.slippage && run(() => paperCall(`/accounts/${accountId}`, "PATCH", { slippage: Number(ev.target.value) }))} />
                </label>
                <label>
                  New account
                  <Input value={newId} placeholder="e.g. claude" onChange={(ev) => setNewId(ev.target.value.toLowerCase())} />
                </label>
              </div>
              <Button size="sm"
                disabled={!ACCOUNT_ID.test(newId)}
                onClick={async () => {
                  if (await run(() => paperCall("/accounts", "POST", { id: newId, capital: state.account.capital, slippage: state.account.slippage }))) {
                    pick(newId);
                    setNewId("");
                  }
                }}
              >
                Create account
              </Button>{" "}
              <Button size="sm"
                onClick={() => {
                  if (window.confirm(`Clear every open position and the whole journal of account "${accountId}"?`)) void run(() => paperCall(`/accounts/${accountId}/reset`, "POST"));
                }}
              >
                Reset account
              </Button>
              {accountId !== "main" && (
                <>
                  {" "}
                  <Button size="sm"
                    onClick={async () => {
                      if (window.confirm(`Delete account "${accountId}" with everything in it?`) && (await run(() => paperCall(`/accounts/${accountId}`, "DELETE")))) pick("main");
                    }}
                  >
                    Delete account
                  </Button>
                </>
              )}
              <p className="muted paper-note-text">
                Limits for orders from Claude over MCP (set on the server): {state.limits.maxLots} lot{state.limits.maxLots === 1 ? "" : "s"} per order. Rates come from the Costs panel.
              </p>
            </details>
          </>
        )}
        <p className="muted paper-note-text">
          Simulated fills on live quotes (buys at the ask, sells at the bid, plus slippage) with the cost rates from the Costs panel. Stops and targets are evaluated by the server whenever the market is live, even with this window closed. Nothing is ever sent to a broker.
        </p>
      </div>
    </div>
  );
}

function TradeRow({ t, px, rs, stamp, onNote }: { t: PaperTrade; px: (s: string, v: number) => string; rs: (v: number) => string; stamp: (t: number) => string; onNote: (note: string) => unknown }) {
  const [note, setNote] = useState(t.note);
  useEffect(() => setNote(t.note), [t.note]);
  return (
    <tr>
      <td className="muted">{stamp(t.closedAt)}</td>
      <td title={[REASON[t.reason], fillText("entry", t.entryFill), fillText("exit", t.exitFill)].filter(Boolean).join("\n")}>
        {t.option ? t.option.label : t.symbol.split(":")[1]} {t.option ? "bought" : t.side === "buy" ? "long" : "short"} {t.lots}× {px(t.symbol, t.entry)}→{px(t.symbol, t.exit)}{" "}
        {labels(t) && <small className="muted paper-labels"> · {labels(t)}</small>}
        {t.rMultiple !== undefined && <small className={t.rMultiple >= 0 ? "up" : "down"}> · {t.rMultiple >= 0 ? "+" : ""}{t.rMultiple}R</small>}
        {!(t.reason === "manual" && t.closedBy === "mcp") && <small className="muted">{REASON[t.reason]}</small>}
        {t.actor === "mcp" && <small className="paper-agent"> · opened by Claude</small>}
        {t.closedBy === "mcp" && <small className="paper-agent"> · closed by Claude</small>}
      </td>
      <td>{rs(t.gross)}</td>
      <td className="muted">{rs(t.costs)}</td>
      <td className={t.net >= 0 ? "up" : "down"}>{rs(t.net)}</td>
      <td>
        <Input className="paper-note no-drag" aria-label={`Note for the ${t.option?.label ?? t.symbol} trade`} value={note} maxLength={500} placeholder="Why / what I learned" onChange={(ev) => setNote(ev.target.value)} onBlur={() => note !== t.note && onNote(note)} />
      </td>
    </tr>
  );
}
