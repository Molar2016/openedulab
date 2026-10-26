import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryLabels {
  title: string;
  body: string;
  retry: string;
  code: string;
}

interface Props {
  labels: ErrorBoundaryLabels;
  onError: (error: Error) => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Isolates a single experiment: a render crash cannot take down navigation, the catalog
 * or other experiments. `onError` receives the raw error only for local, sanitised
 * reporting (the reporter drops message/stack).
 */
export class ExperimentErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError(error);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="experiment-error" role="alert" data-testid="experiment-error">
          <h2>{this.props.labels.title}</h2>
          <p>{this.props.labels.body}</p>
          <p className="muted small">{this.props.labels.code}</p>
          <button type="button" className="button" onClick={this.handleRetry}>
            {this.props.labels.retry}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
