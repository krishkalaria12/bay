import { Component, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Shown in place of the children after they throw. */
  fallback?: ReactNode;
  /** A change clears the error and renders the children again. */
  resetKey?: unknown;
  onError?: (error: Error) => void;
};

/** Keeps a throwing part of the window from unmounting the rest of it. */
export class ErrorBoundary extends Component<Props, { error: Error | null; resetKey: unknown }> {
  // SAFETY: the initializer is null, which satisfies Error | null; the cast only pins the state field type.
  state = { error: null as Error | null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: { error: Error | null; resetKey: unknown }) {
    return Object.is(props.resetKey, state.resetKey) ? null : { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error) {
    console.error(error);
    this.props.onError?.(error);
  }

  render() {
    return this.state.error ? (this.props.fallback ?? null) : this.props.children;
  }
}
