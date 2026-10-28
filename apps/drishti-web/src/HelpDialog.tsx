import { useEffect, useRef } from "react";
import { MNEMONICS } from "./command";
import { useSettings } from "./settings";
import { WIDGETS } from "./widgets";
import { Button, Dialog, DialogContent, DialogTitle } from "./ui";

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
  const seen = useSettings((s) => s.helpSeen);
  const set = useSettings((s) => s.set);
  const wasOpen = useRef(open);

  // the welcome sheet counts as seen once it has been shown and closed, however it was closed
  useEffect(() => {
    if (wasOpen.current && !open && !seen) set({ helpSeen: true });
    wasOpen.current = open;
  }, [open, seen, set]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="settings help" aria-describedby={undefined}>
      <header>
        <DialogTitle asChild>
          <strong>{seen ? "Help" : "Welcome to Divya Drishti"}</strong>
        </DialogTitle>
      </header>
      <div className="settings-body">
        {!seen && (
          <p className="hint">
            Live MCX and NYMEX energy prices, news, options and calendar in panels you arrange. <kbd>F1</kbd> is the Evening desk and <kbd>F2</kbd> to <kbd>F6</kbd> the research desks, or{" "}
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
          <Button variant="default" onClick={() => onClose()}>
            Got it
          </Button>
        </footer>
      </div>
      </DialogContent>
    </Dialog>
  );
}
