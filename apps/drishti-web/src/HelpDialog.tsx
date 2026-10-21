import { useEffect, useRef } from "react";
import { MNEMONICS } from "./command";
import { useSettings } from "./settings";
import { WIDGETS } from "./widgets";

const SHORTCUTS: [string, string][] = [
  ["Ctrl K", "Command palette: a symbol (CRUDEOIL), a panel code (GP, Q, OC…), or both (CL GP)"],
  ["F1 … F9", "Switch workspace (built-in desks first, then your saved ones)"],
  ["Alt 1 … 9", "Add a panel (same order as the sidebar)"],
  ["Ctrl ,", "Settings"],
  ["?", "This help"],
];

const GLOSSARY: [string, string][] = [
  ["OI", "Open interest: futures or option contracts still open. Rising OI with rising price means new money is backing the move."],
  ["ATP", "Average traded price today (volume-weighted). Price above ATP means buyers are paying up."],
  ["PCR", "Put/call ratio by open interest over the strikes shown. Above 1 means more puts than calls."],
  ["Max pain", "The option strike where writers pay out the least. Prices often drift toward it near expiry."],
  ["IV · Δ", "Implied volatility (%) and delta: how much an option moves per 1 move in the underlying."],
  ["LIVE · STALE · CLOSED", "LIVE: the exchange is open and the feed is updating. STALE: open but silent for over a minute. CLOSED: the exchange is shut, you see the last price."],
  ["DELAYED 10m", "Free feed that runs behind the exchange (NYMEX via Yahoo)."],
  ["Link groups", "The coloured dot on a panel: panels with the same colour follow the same symbol. Click it to change group, or pin a panel to its own symbol."],
];

/** Shortcuts, panel codes and a glossary. Opens with `?`, the topbar button, and once on first run. */
export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const seen = useSettings((s) => s.helpSeen);
  const set = useSettings((s) => s.set);

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="settings help"
      aria-label="Help"
      onClose={() => {
        if (!seen) set({ helpSeen: true });
        onClose();
      }}
      onMouseDown={(e) => e.target === ref.current && onClose()}
    >
      <header>
        <strong>{seen ? "Help" : "Welcome to Divya Drishti"}</strong>
        <button className="close" aria-label="Close help" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="settings-body">
        {!seen && (
          <p className="hint">
            Live MCX and NYMEX energy prices, news, options and calendar in panels you arrange. Try <kbd>F2</kbd> for the natural-gas desk, or{" "}
            <kbd>Ctrl K</kbd> and type <b>OC</b>.
          </p>
        )}
        <h3>Keyboard</h3>
        <dl className="help-list">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
        <h3>Panel codes</h3>
        <dl className="help-list">
          {Object.entries(MNEMONICS).map(([code, type]) => (
            <div key={code}>
              <dt>
                <kbd>{code}</kbd>
              </dt>
              <dd>{WIDGETS[type].title}</dd>
            </div>
          ))}
        </dl>
        <h3>What the terms mean</h3>
        <dl className="help-list">
          {GLOSSARY.map(([t, d]) => (
            <div key={t}>
              <dt>{t}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
        <footer>
          <button className="btn" onClick={onClose}>
            Got it
          </button>
        </footer>
      </div>
    </dialog>
  );
}
