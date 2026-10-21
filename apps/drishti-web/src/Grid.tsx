import { Component, type ReactNode } from "react";
import { Responsive, useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { WIDGETS } from "./widgets";
import { useSettings } from "./settings";
import { useWidgetSymbol, useWorkspace, type Widget } from "./workspace";

/**
 * One panel crashing (bad data, a library throw) must not blank the whole terminal: React unmounts the entire
 * tree on an uncaught render error, so each panel body gets its own boundary with a retry.
 */
class PanelBoundary extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.title}] panel crashed:`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-error" role="alert">
        <strong>{this.props.title} stopped working</strong>
        <span className="muted">{this.state.error.message}</span>
        <button className="btn no-drag" onClick={() => this.setState({ error: null })}>
          Retry
        </button>
      </div>
    );
  }
}

function Panel({ widget }: { widget: Widget }) {
  const symbol = useWidgetSymbol(widget);
  const focused = useWorkspace((s) => s.focusedId === widget.id);
  const { focus, cycleGroup, removeWidget } = useWorkspace.getState();
  const { title, component: Body, linked, showSymbol } = WIDGETS[widget.type];

  return (
    <section className={focused ? "panel focused" : "panel"} onMouseDown={() => focus(widget.id)}>
      <header className="panel-title">
        {linked && (
          <button
            className={`group-dot no-drag ${widget.group ?? "pinned"}`}
            title={widget.group ? `Linked: ${widget.group} (click to change)` : "Pinned (click to link)"}
            aria-label="Change link group"
            onClick={() => cycleGroup(widget.id)}
          />
        )}
        <span>{title}</span>
        {showSymbol && <strong>{symbol}</strong>}
        <button
          className="close no-drag"
          aria-label="Close panel"
          onClick={() =>
            (!useSettings.getState().confirmClose || confirm(`Close ${title} panel?`)) && removeWidget(widget.id)
          }
        >
          ✕
        </button>
      </header>
      <div className="panel-body">
        <PanelBoundary title={title}>
          <Body widget={widget} />
        </PanelBoundary>
      </div>
    </section>
  );
}

export function Workspace() {
  const widgets = useWorkspace((s) => s.widgets);
  const layout = useWorkspace((s) => s.layout);
  const setLayout = useWorkspace((s) => s.setLayout);
  const locked = useSettings((s) => s.lockLayout);
  const compact = useSettings((s) => s.density === "compact");
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true }); // no 1280px first paint sliding into place

  return (
    <div ref={containerRef} className="workspace">
      {mounted && (
        <Responsive
          width={width}
          layouts={{ lg: layout }}
          breakpoints={{ lg: 640, xs: 0 }}
          cols={{ lg: 12, xs: 1 }}
          rowHeight={compact ? 30 : 36}
          margin={[4, 4]}
          dragConfig={{ enabled: !locked, handle: ".panel-title", cancel: ".no-drag" }}
          resizeConfig={{ enabled: !locked }}
          // only the desktop layout is stored; the 1-column phone layout is derived from it
          onLayoutChange={(_, all) => all.lg && setLayout(all.lg)}
        >
          {widgets.map((w) => (
            <div key={w.id}>
              <Panel widget={w} />
            </div>
          ))}
        </Responsive>
      )}
    </div>
  );
}
