import { useEffect, useState } from "react";
import { SimulatedBanner } from "./SourceBadge";
import { Palette } from "./Palette";
import { startAlertEngine } from "./alertEngine";
import { syncRatesToServer } from "./paperClient";
import { Toasts } from "./AlertsPanel";
import { HelpDialog } from "./HelpDialog";
import { SettingsDialog } from "./SettingsDialog";
import { StatusBar } from "./StatusBar";
import { useSettings } from "./settings";
import { useStore } from "./store";
import { TickerTape } from "./TickerTape";
import { Workspace } from "./Grid";
import { PANEL_TYPES, Sidebar } from "./Sidebar";
import { workspaceList } from "./presets";
import { useWorkspace } from "./workspace";

export function App() {
  const status = useStore((s) => s.status);
  const paletteOpen = useWorkspace((s) => s.paletteOpen);
  const { setPaletteOpen, addWidget, loadWorkspace } = useWorkspace.getState();
  const setSettingsOpen = useSettings((s) => s.setOpen);
  const [menuOpen, setMenuOpen] = useState(false); // phone-width sidebar overlay
  const helpSeen = useSettings((s) => s.helpSeen);
  const [helpOpen, setHelpOpen] = useState(!helpSeen); // first run shows the welcome sheet once

  useEffect(() => startAlertEngine(), []);
  useEffect(() => void syncRatesToServer(), []); // cost rates edited in the Costs panel are also what the server charges paper trades

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === "?" && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName) && !(e.target as HTMLElement).isContentEditable) {
        setHelpOpen(true);
      } else if (/^F[1-9]$/.test(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        // F1…F9 switch workspace (presets first, then saved ones); F1 would otherwise open the browser's help
        const ws = workspaceList(useWorkspace.getState().saved)[Number(e.key.slice(1)) - 1];
        if (ws) {
          e.preventDefault();
          loadWorkspace(ws.key);
        }
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
        // Alt+1…9 adds a panel (e.code: works on any keyboard layout)
        const type = PANEL_TYPES[Number(e.code.slice(5)) - 1];
        if (type) {
          e.preventDefault();
          addWidget(type);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen, setSettingsOpen, addWidget, loadWorkspace]);

  return (
    <div className="shell">
      <SimulatedBanner />
      <header className="topbar">
        <button className="menu-btn" aria-label="Panels" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          ☰
        </button>
        <h1 className="brand">
          <img className="brand-logo" src="/logo.svg" alt="" width={22} height={22} />
          DIVYA DRISHTI
        </h1>
        <button className="cmd" onClick={() => setPaletteOpen(true)}>
          <span className="muted">Command…</span> <kbd>Ctrl K</kbd>
        </button>
        <span className={`status ${status}`}>● {status}</span>
        <button className="gear" title="Help and shortcuts (?)" aria-label="Help" onClick={() => setHelpOpen(true)}>
          ?
        </button>
        <button className="gear" title="Settings (Ctrl+,)" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
      </header>
      <TickerTape />
      <div className="main-area">
        <Sidebar mobileOpen={menuOpen} onClose={() => setMenuOpen(false)} />
        <main className="workspace-main" aria-label="Panels">
          <Workspace />
        </main>
      </div>
      {paletteOpen && <Palette />}
      <StatusBar />
      <Toasts />
      <SettingsDialog />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
