import { useEffect, useState } from "react";
import { describe, SYMBOLS, type Alert, type AlertKind, type AlertOp } from "@drishti/shared";
import { useAlerts } from "./alertsStore";
import { useServerAlerts } from "./serverAlertsClient";
import { useClock, useSettings } from "./settings";
import type { Widget } from "./workspace";
import { Button, Input, Select } from "./ui";

const RELEASES = ["EIA crude", "EIA natural gas", "API crude", "Baker Hughes"];
const LEADS = [5, 15, 30, 60];
const KINDS: [AlertKind, string][] = [
  ["price", "Price crosses"],
  ["change", "Day move of"],
  ["news", "Headline mentions"],
  ["release", "Before a release"],
];

/** Alerts: price levels, day moves, headline keywords and releases (EIA, API, rigs). Checked while the app is open. */
export function AlertsWidget(_: { widget: Widget }) {
  const { alerts, history, add, remove, rearm } = useAlerts();
  const sound = useSettings((s) => s.alertSound);
  const set = useSettings((s) => s.set);
  const clock = useClock();
  const [kind, setKind] = useState<AlertKind>("price");
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [op, setOp] = useState<AlertOp>("above");
  const [value, setValue] = useState("");
  const [text, setText] = useState("");
  const [release, setRelease] = useState(RELEASES[0]);
  const [lead, setLead] = useState(15);
  const [perm, setPerm] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const server = useServerAlerts();
  const [onServer, setOnServer] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const num = Number(value);
  const valid =
    kind === "news" ? text.trim() !== "" : kind === "release" ? true : value.trim() !== "" && Number.isFinite(num) && (kind === "price" ? num > 0 : num !== 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const rule: Omit<Alert, "id" | "armed"> =
      kind === "price" ? { kind, symbol, op, value: num } : kind === "change" ? { kind, symbol, op: num < 0 ? "below" : "above", value: num } : kind === "news" ? { kind, text: text.trim() } : { kind, text: release, minutes: lead };
    if (onServer) {
      const err = await server.add(rule);
      setNote(err ?? null);
      if (err) return; // keep the form so nothing is lost
    } else add(rule);
    setValue("");
    setText("");
  };

  return (
    <div className="alerts">
      <form className="alert-form no-drag" onSubmit={submit}>
        <Select aria-label="Alert type" value={kind} onChange={(e) => setKind(e.target.value as AlertKind)}>
          {KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
        {(kind === "price" || kind === "change") && (
          <Select aria-label="Instrument" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {SYMBOLS.map((s) => (
              <option key={s} value={s}>
                {s.split(":")[1]}
              </option>
            ))}
          </Select>
        )}
        {kind === "price" && (
          <Select aria-label="Direction" value={op} onChange={(e) => setOp(e.target.value as AlertOp)}>
            <option value="above">above</option>
            <option value="below">below</option>
          </Select>
        )}
        {(kind === "price" || kind === "change") && (
          <Input
            aria-label={kind === "price" ? "Price level" : "Percent move (negative for a fall)"}
            placeholder={kind === "price" ? "price" : "% (-2 = down 2%)"}
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        {kind === "news" && <Input aria-label="Keyword" placeholder="keyword, e.g. OPEC" value={text} onChange={(e) => setText(e.target.value)} />}
        {kind === "release" && (
          <>
            <Select aria-label="Release" value={release} onChange={(e) => setRelease(e.target.value)}>
              {RELEASES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
            <Select aria-label="Lead time" value={lead} onChange={(e) => setLead(Number(e.target.value))}>
              {LEADS.map((m) => (
                <option key={m} value={m}>
                  {m} min before
                </option>
              ))}
            </Select>
          </>
        )}
        <label className="alert-server muted" title="Kept on the server: fires with this window closed and is sent to Telegram or your webhook">
          <input type="checkbox" checked={onServer} onChange={(e) => setOnServer(e.target.checked)} /> From the server
        </label>
        <Button size="sm" type="submit" disabled={!valid}>
          Add alert
        </Button>
      </form>
      {note && <p className="down alert-note">{note}</p>}

      <div className="alert-opts muted">
        <label>
          <input type="checkbox" checked={sound} onChange={(e) => set({ alertSound: e.target.checked })} /> Sound
        </label>
        {perm === "default" && (
          <Button size="sm" onClick={() => Notification.requestPermission().then(setPerm)}>
            Enable desktop notifications
          </Button>
        )}
        {perm === "granted" && <span>Desktop notifications on</span>}
        {perm === "denied" && <span title="Allow notifications for this site in the browser settings">Notifications blocked</span>}
        <span className="alert-note">Local alerts are checked while this window is open.</span>
      </div>
      <div className="alert-opts muted" aria-label="Server alert delivery">
        {server.error ? (
          <span title={server.error}>Server alerts unavailable: {server.error}</span>
        ) : server.channels ? (
          <>
            <span>
              Server alerts: Telegram {server.channels.telegramLinked ? "linked" : server.channels.telegram ? "bot set, chat not linked" : "not set up"}
              {server.channels.webhook ? " · webhook set" : ""}
            </span>
            {server.channels.telegram && !server.channels.telegramLinked && (
              <Button size="sm" title="First send your bot any message in Telegram" onClick={async () => setNote(await server.link())}>
                Link Telegram
              </Button>
            )}
            {(server.channels.telegramLinked || server.channels.webhook) && (
              <Button size="sm" title="Sends one real message to your chat / webhook" onClick={async () => setNote(await server.test())}>
                Send test message
              </Button>
            )}
          </>
        ) : null}
      </div>

      <div className="alert-list" tabIndex={0} role="region" aria-label="Alerts">
        {alerts.length === 0 && server.alerts.length === 0 && <p className="empty muted">No alerts yet. Add one above.</p>}
        {server.alerts.map((a) => (
          <div key={a.id} className={`alert-row${a.armed ? "" : " spent"}`}>
            <span className="alert-text">
              {describe(a)} <small className="muted" title="Evaluated by the server: fires with the app closed, sent to Telegram / webhook">· server</small>
            </span>
            <span className="muted alert-state">{a.armed ? "watching" : `fired ${clock.time(a.firedAt ?? 0)}`}</span>
            {!a.armed && (
              <Button size="sm" onClick={() => server.rearm(a.id)}>
                Re-arm
              </Button>
            )}
            <button aria-label={`Delete server alert ${describe(a)}`} className="alert-del" onClick={() => server.remove(a.id)}>
              ×
            </button>
          </div>
        ))}
        {alerts.map((a) => (
          <div key={a.id} className={`alert-row${a.armed ? "" : " spent"}`}>
            <span className="alert-text">{describe(a)}</span>
            <span className="muted alert-state">{a.armed ? "watching" : `fired ${clock.time(a.firedAt ?? 0)}`}</span>
            {!a.armed && (
              <Button size="sm" onClick={() => rearm(a.id)}>
                Re-arm
              </Button>
            )}
            <button aria-label={`Delete alert ${describe(a)}`} className="alert-del" onClick={() => remove(a.id)}>
              ×
            </button>
          </div>
        ))}
        {history.length > 0 && <h2>Recent</h2>}
        {history.slice(0, 10).map((h) => (
          <div key={h.id} className="alert-hist">
            <span className="muted">{clock.stamp(h.at)}</span> {h.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function ToastItem({ id, message, onDone }: { id: string; message: string; onDone: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDone(id), 10_000);
    return () => clearTimeout(timer);
  }, [id, onDone]);
  return (
    <button className="toast" onClick={() => onDone(id)} title="Dismiss">
      <b>Alert</b> {message}
    </button>
  );
}

/** On-screen notices for fired alerts; each goes away after 10 s or on click. */
export function Toasts() {
  const toasts = useAlerts((s) => s.toasts);
  const dismiss = useAlerts((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} id={t.id} message={t.message} onDone={dismiss} />
      ))}
    </div>
  );
}
