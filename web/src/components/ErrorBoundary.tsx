import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Keeps a rendering bug in one page from blanking the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Athena UI error', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <div className="note note--error" role="alert">
          <strong>This page failed to render.</strong>
          <div className="note__hint">{this.state.error.message}</div>
          <div className="note__actions">
            <button className="btn btn--sm" onClick={() => this.setState({ error: null })}>Try again</button>
            <button className="btn btn--sm" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}
