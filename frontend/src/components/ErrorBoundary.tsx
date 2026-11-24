import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Fills the whole window instead of the page area (used around the whole app). */
  fullPage?: boolean;
}

interface State {
  error: Error | null;
}

/** A page file that could not be fetched: the connection dropped, or a newer version replaced it. */
const isLoadFailure = (error: Error) => /dynamically imported module|importing a module script failed|failed to fetch|error loading/i.test(error.message);

/**
 * Catches an error while a page is drawn and shows a way out, instead of React removing the
 * whole app and leaving a blank window. Saved work is on the server, so reloading loses nothing.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('A page failed to draw:', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const loadFailure = isLoadFailure(error);

    return (
      <div className={this.props.fullPage ? 'page-error full' : 'page-error'} role="alert">
        <h1>{loadFailure ? 'This page could not be loaded' : 'Something went wrong on this page'}</h1>
        <p>
          {loadFailure
            ? 'Check your connection and reload. If a new version of Delta HRMS was just released, reloading picks it up.'
            : 'Your saved work is safe. Reload the page, or go back to Home.'}
        </p>
        <div className="form-actions">
          <a className="btn ghost" href="/">
            Go to Home
          </a>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
