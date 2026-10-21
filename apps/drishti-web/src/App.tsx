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
import { useWorkspace } from "./workspace";

export function App() {
  const status = useStore((s) => s.status);
  const paletteOpen = useWorkspace((s) => s.paletteOpen);
  const { setPaletteOpen, addWidget } = useWorkspace.getState();
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
  }, [setPaletteOpen, setSettingsOpen, addWidget]);

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
