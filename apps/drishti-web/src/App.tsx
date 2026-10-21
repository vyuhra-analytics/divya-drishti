import { useEffect, useState } from "react";
import { SYMBOLS } from "@drishti/shared";
import { Palette } from "./Palette";
import { SettingsDialog } from "./SettingsDialog";
import { StatusBar } from "./StatusBar";
import { useSettings } from "./settings";
import { useStore } from "./store";
import { Price } from "./widgets";
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
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
      <header className="topbar">
        <button className="menu-btn" aria-label="Panels" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          ☰
        </button>
        <strong className="brand">DIVYA DRISHTI</strong>
        <button className="cmd" onClick={() => setPaletteOpen(true)}>
          <span className="muted">Command…</span> <kbd>Ctrl K</kbd>
        </button>
        <div className="ticker">
          {SYMBOLS.map((s) => (
            <span key={s}>
              {s.split(":")[1]} <Price symbol={s} />
            </span>
          ))}
        </div>
        <span className={`status ${status}`}>● {status}</span>
        <button className="gear" title="Settings (Ctrl+,)" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
      </header>
      <div className="main-area">
        <Sidebar mobileOpen={menuOpen} onClose={() => setMenuOpen(false)} />
        <Workspace />
      </div>
      {paletteOpen && <Palette />}
      <StatusBar />
      <SettingsDialog />
    </div>
  );
}
