import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  readonly children: ReactNode
}

interface ErrorBoundaryState {
  readonly failed: boolean
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Loremaster render failure', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="fatal-state">
          <p className="eyebrow">Archive interrupted</p>
          <h1>The record could not be opened.</h1>
          <p>Reload the page to return to the daily archive.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload archive
          </button>
        </main>
      )
    }
    return this.props.children
  }
}
