import { useEffect } from "react";
import { SYMBOLS } from "@drishti/shared";
import { Palette } from "./Palette";
import { SettingsDialog } from "./SettingsDialog";
import { useSettings } from "./settings";
import { useStore } from "./store";
import { Price, WIDGETS } from "./widgets";
import { Workspace } from "./Grid";
import { useWorkspace, type WidgetType } from "./workspace";

export function App() {
  const status = useStore((s) => s.status);
  const paletteOpen = useWorkspace((s) => s.paletteOpen);
  const { setPaletteOpen, addWidget } = useWorkspace.getState();
  const setSettingsOpen = useSettings((s) => s.setOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen, setSettingsOpen]);

  return (
    <div className="shell">
      <header className="topbar">
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
        {(Object.keys(WIDGETS) as WidgetType[]).map((t) => (
          <button key={t} className="tf" onClick={() => addWidget(t)}>
            + {WIDGETS[t].title}
          </button>
        ))}
        <span className={`status ${status}`}>● {status}</span>
        <button className="gear" title="Settings (Ctrl+,)" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
      </header>
      <Workspace />
      {paletteOpen && <Palette />}
      <SettingsDialog />
    </div>
  );
}
