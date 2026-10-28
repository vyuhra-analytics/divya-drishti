import { useEffect, useRef, useState, type ReactNode } from "react";
import { TIMEFRAMES, type Timeframe } from "@drishti/shared";
import { reconnect, useStore } from "./store";
import { DEFAULTS, useSettings, validateUrl, type Settings } from "./settings";
import { BUILTIN_CHANNELS } from "./TvWidget";
import { Feeds } from "./Feeds";
import { InstrumentsSettings } from "./InstrumentsSettings";

function TvChannels() {
  const channels = useSettings((s) => s.tvChannels);
  const set = useSettings((s) => s.set);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const urlErr = validateUrl(url, ["https:", "http:"]);
  const dupe = [...BUILTIN_CHANNELS, ...channels].some((c) => c.url === url.trim());
  const canAdd = name.trim() && url.trim() && !urlErr && !dupe;

  return (
    <>
      <p className="muted hint">Built in: {BUILTIN_CHANNELS.map((c) => c.name).join(", ")}.</p>
      {channels.map((c) => (
        <div className="field" key={c.url}>
          <span>
            {c.name}
            <small className="muted tv-url">{c.url}</small>
          </span>
          <button className="btn" onClick={() => set({ tvChannels: channels.filter((x) => x !== c) })}>
            Remove
          </button>
        </div>
      ))}
      <form
        className="field tv-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canAdd) return;
          set({ tvChannels: [...channels, { name: name.trim(), url: url.trim() }] });
          setName("");
          setUrl("");
        }}
      >
        <input value={name} placeholder="Channel name" aria-label="Channel name" onChange={(e) => setName(e.target.value)} />
        <input value={url} placeholder="https://…/playlist.m3u8" aria-label="Stream URL" onChange={(e) => setUrl(e.target.value)} />
        <button className="btn" disabled={!canAdd}>
          Add
        </button>
      </form>
      {(urlErr || dupe) && <p className="field-error">{urlErr ?? "channel already added"}</p>}
      <p className="muted hint">Add your own channels: official broadcaster streams only (HLS .m3u8).</p>
    </>
  );
}
import { useWorkspace } from "./workspace";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>
        {label}
        {hint && <small className="muted">{hint}</small>}
      </span>
      {children}
    </label>
  );
}

function Select<K extends keyof Settings>({ k, options }: { k: K; options: [Settings[K], string][] }) {
  const value = useSettings((s) => s[k]);
  const set = useSettings((s) => s.set);
  return (
    <select
      value={String(value)}
      onChange={(e) => set({ [k]: options.find(([v]) => String(v) === e.target.value)![0] } as Partial<Settings>)}
    >
      {options.map(([v, label]) => (
        <option key={String(v)} value={String(v)}>
          {label}
        </option>
      ))}
    </select>
  );
}

function Toggle({ k }: { k: "flash" | "lockLayout" | "confirmClose" }) {
  const value = useSettings((s) => s[k]);
  const set = useSettings((s) => s.set);
  return <input type="checkbox" checked={value} onChange={(e) => set({ [k]: e.target.checked })} />;
}

/** URL fields edit a draft; saving validates, stores and reconnects. */
function Connection({ savedApi, savedStream }: { savedApi: string; savedStream: string }) {
  const set = useSettings((s) => s.set);
  const status = useStore((s) => s.status);
  const [api, setApi] = useState(savedApi);
  const [stream, setStream] = useState(savedStream);
  const apiErr = validateUrl(api, ["http:", "https:"]);
  const streamErr = validateUrl(stream, ["ws:", "wss:"]);

  return (
    <div className="set-grid">
      <Field label="API URL" hint="empty = default (dev proxy /api)">
        <input value={api} placeholder="http://localhost:3001" onChange={(e) => setApi(e.target.value)} />
      </Field>
      {apiErr && <p className="field-error wide">{apiErr}</p>}
      <Field label="Stream URL" hint="empty = default (dev proxy /ws)">
        <input value={stream} placeholder="ws://localhost:3002/ws" onChange={(e) => setStream(e.target.value)} />
      </Field>
      {streamErr && <p className="field-error wide">{streamErr}</p>}
      <div className="field wide">
        <span className={`status ${status}`}>● {status}</span>
        <button
          className="btn"
          disabled={!!apiErr || !!streamErr}
          onClick={() => {
            set({ apiUrl: api.trim(), streamUrl: stream.trim() });
            reconnect();
          }}
        >
          Save &amp; reconnect
        </button>
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const open = useSettings((s) => s.open);
  const setOpen = useSettings((s) => s.setOpen);
  const resetSettings = useSettings((s) => s.reset);
  const savedApi = useSettings((s) => s.apiUrl);
  const savedStream = useSettings((s) => s.streamUrl);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="settings"
      aria-label="Settings"
      onClose={() => setOpen(false)}
      onMouseDown={(e) => e.target === ref.current && setOpen(false)} // click on backdrop
    >
      <header>
        <strong>Settings</strong>
        <button className="close" aria-label="Close settings" onClick={() => setOpen(false)}>
          ✕
        </button>
      </header>
      {open && (
        <div className="settings-body">
          <section>
            <h3>Appearance</h3>
            <Field label="Theme">
              <Select k="theme" options={[["dark", "Dark"], ["light", "Light"]]} />
            </Field>
            <Field label="Density">
              <Select k="density" options={[["compact", "Compact"], ["comfortable", "Comfortable"]]} />
            </Field>
            <Field label="Font size">
              <Select k="fontSize" options={[12, 13, 14, 15, 16].map((n) => [n, `${n}px`] as [number, string])} />
            </Field>
            <Field label="Up / down colours">
              <Select
                k="colors"
                options={[
                  ["green-red", "Green up · Red down"],
                  ["red-green", "Red up · Green down"],
                  ["blue-orange", "Blue up · Orange down (colour-blind)"],
                ]}
              />
            </Field>
          </section>

          <section>
            <h3>Data &amp; formatting</h3>
            <Field label="Number format">
              <Select k="locale" options={[["en-IN", "Indian (12,34,567.89)"], ["en-US", "International (1,234,567.89)"]]} />
            </Field>
            <Field label="Clock">
              <Select k="clock" options={[["12h", "12-hour (10:42 pm)"], ["24h", "24-hour (22:42)"]]} />
            </Field>
            <Field label="Price decimals">
              <Select
                k="decimals"
                options={[[-1, "Auto (per instrument)"], ...[0, 1, 2, 3, 4].map((n) => [n, String(n)] as [number, string])]}
              />
            </Field>
            <Field label="Default timeframe" hint="for new charts">
              <Select
                k="defaultTf"
                options={(Object.keys(TIMEFRAMES) as Timeframe[]).map((t) => [t, t] as [Timeframe, string])}
              />
            </Field>
            <Field label="Flash prices on tick">
              <Toggle k="flash" />
            </Field>
          </section>

          <section>
            <h3>Workspace</h3>
            <Field label="Lock layout" hint="no drag / resize">
              <Toggle k="lockLayout" />
            </Field>
            <Field label="Confirm before closing panels">
              <Toggle k="confirmClose" />
            </Field>
            <div className="field">
              <span>Workspace layout</span>
              <button
                className="btn"
                onClick={() => confirm("Reset panels, link groups and layout to defaults?") && useWorkspace.getState().reset()}
              >
                Reset workspace
              </button>
            </div>
          </section>

          <section>
            <h3>Live TV</h3>
            <TvChannels />
          </section>

          <section className="wide">
            <h3>Instruments</h3>
            <InstrumentsSettings />
          </section>

          <section className="wide">
            <h3>Data feeds</h3>
            <Feeds />
          </section>

          <section className="wide">
            <h3>Connection</h3>
            {/* key: re-seed drafts when saved URLs change (e.g. restore defaults) */}
            <Connection key={savedApi + "|" + savedStream} savedApi={savedApi} savedStream={savedStream} />
          </section>

          <footer>
            <button
              className="btn"
              onClick={() => {
                const overridden = savedStream !== DEFAULTS.streamUrl;
                resetSettings();
                if (overridden) reconnect();
              }}
            >
              Restore default settings
            </button>
          </footer>
        </div>
      )}
    </dialog>
  );
}
