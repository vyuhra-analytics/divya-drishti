import { MNEMONICS } from "./command";
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
  const { addWidget, reset } = useWorkspace.getState();

  return (
    <nav className={`sidebar${collapsed ? " collapsed" : ""}${mobileOpen ? " mobile-open" : ""}`} aria-label="Panels">
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
