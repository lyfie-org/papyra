import { Component, type ErrorInfo as ReactErrorInfo, type ReactNode } from 'react';
import { clientErrorInfo, type ErrorInfo } from '../lib/errorReport';

interface Props {
  /** What to draw instead: gets the failure and a way to try rendering again. */
  fallback: (info: ErrorInfo, reset: () => void) => ReactNode;
  /** Changing this clears the error — navigating away should not stay broken. */
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  info: ErrorInfo | null;
  key: unknown;
}

/**
 * Catches a render crash below it. Without one, one bad note or page unmounted
 * the whole app and left a blank screen with the reason only in the console.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { info: null, key: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { info: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: unknown, react: ReactErrorInfo) {
    console.error('[papyra] render crash', error);
    this.setState({ info: clientErrorInfo(error, react.componentStack) });
  }

  private reset = () => this.setState({ info: null });

  render() {
    return this.state.info ? this.props.fallback(this.state.info, this.reset) : this.props.children;
  }
}
