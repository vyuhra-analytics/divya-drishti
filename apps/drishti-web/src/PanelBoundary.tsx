import { Component, type ReactNode } from "react";

/**
 * One panel crashing (bad data, a library throw) must not blank the whole terminal: React unmounts the entire
 * tree on an uncaught render error, so each panel body gets its own boundary with a retry.
 */
export class PanelBoundary extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
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
