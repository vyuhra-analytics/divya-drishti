import { MNEMONICS } from "./command";
import { workspaceList } from "./presets";
import { useSettings } from "./settings";
import { WIDGETS } from "./widgets";
import { useWorkspace, type WidgetType } from "./workspace";

/** Panel types in registry order; Alt+1… follows this order. */
export const PANEL_TYPES = Object.keys(WIDGETS) as WidgetType[];
const CODE: Partial<Record<WidgetType, string>> = Object.fromEntries(Object.entries(MNEMONICS).map(([code, type]) => [type, code]));

/** Left rail: add any panel (click or Alt+number), reset the layout, collapse to codes only. */
export function Sidebar({ mobileOpen, onClose }: { mobileOpen: boolean; onClose: () => void }) {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const set = useSettings((s) => s.set);
  const { addWidget, reset, loadWorkspace, saveWorkspace, deleteWorkspace } = useWorkspace.getState();
  const saved = useWorkspace((s) => s.saved);
  const active = useWorkspace((s) => s.activeWorkspace);
  const workspaces = workspaceList(saved);
  const saveCurrent = () => {
    const name = prompt("Save the current layout as:", active && active in saved ? active : "");
    if (name !== null && !saveWorkspace(name)) alert("Pick a different name: it's empty, matches a built-in workspace, or you have too many saved.");
  };

  return (
    <nav className={`sidebar${collapsed ? " collapsed" : ""}${mobileOpen ? " mobile-open" : ""}`} aria-label="Panels">
      <div className="sb-head">{!collapsed && <span className="muted">Workspaces</span>}</div>
      <ul>
        {workspaces.map((w, i) => (
          <li key={w.key} className="ws-item">
            <button
              className={w.name === active ? "active" : undefined}
              title={`${w.name}: ${w.hint}${i < 9 ? ` (F${i + 1})` : ""}`}
              onClick={() => {
                loadWorkspace(w.key);
                onClose();
              }}
            >
              <span className="code">{i < 9 ? `F${i + 1}` : "•"}</span>
              {!collapsed && <span className="name">{w.name}</span>}
            </button>
            {w.saved && !collapsed && (
              <button className="ws-del" aria-label={`Delete workspace ${w.name}`} title="Delete" onClick={() => confirm(`Delete workspace "${w.name}"?`) && deleteWorkspace(w.name)}>
                ×
              </button>
            )}
          </li>
        ))}
        <li>
          <button title="Save the current layout as a workspace" onClick={saveCurrent}>
            <span className="code">＋</span>
            {!collapsed && <span className="name">Save layout…</span>}
          </button>
        </li>
      </ul>
      <div className="sb-head">{!collapsed && <span className="muted">Add panel</span>}</div>
      <ul>
        {PANEL_TYPES.map((t, i) => (
          <li key={t}>
            <button
              title={`Add ${WIDGETS[t].title}${i < 9 ? ` (Alt+${i + 1})` : ""}${CODE[t] ? ` · command ${CODE[t]}` : ""}`}
              onClick={() => {
                addWidget(t);
                onClose();
              }}
            >
              <span className="code">{CODE[t] ?? WIDGETS[t].title.slice(0, 2).toUpperCase()}</span>
              {!collapsed && <span className="name">{WIDGETS[t].title}</span>}
              {!collapsed && i < 9 && <kbd>Alt {i + 1}</kbd>}
            </button>
          </li>
        ))}
      </ul>
      <div className="sb-foot">
        <button
          title="Reset layout to defaults"
          onClick={() => confirm("Reset panels, link groups and layout to defaults?") && (reset(), onClose())}
        >
          <span className="code">↺</span>
          {!collapsed && <span className="name">Reset layout</span>}
        </button>
        <button
          className="collapse"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => set({ sidebarCollapsed: !collapsed })}
        >
          <span className="code">{collapsed ? "»" : "«"}</span>
        </button>
      </div>
    </nav>
  );
}
