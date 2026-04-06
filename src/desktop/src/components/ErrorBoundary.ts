import React, { type ReactNode } from "react"

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error) => void
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(error, info)
    this.props.onError?.(error)
  }

  private readonly handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    const { children, fallback } = this.props
    const { hasError, error } = this.state

    if (!hasError) {
      return children
    }

    if (fallback) {
      return fallback
    }

    const summary = (error?.message ?? "Something went wrong").slice(0, 200)

    return React.createElement(
      "div",
      {
        role: "alert",
        "data-testid": "error-boundary-fallback",
        style: {
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          padding: "12px 16px",
        },
      },
      React.createElement(
        "div",
        { style: { display: "flex", alignItems: "flex-start", gap: 10 } },
        React.createElement("span", { "aria-hidden": true, style: { color: "var(--color-muted)", lineHeight: 1.2 } }, "⚠"),
        React.createElement(
          "div",
          { style: { minWidth: 0, flex: 1 } },
          React.createElement("div", { style: { color: "var(--color-ink)", fontSize: 14, fontWeight: 600 } }, "Something went wrong"),
          React.createElement(
            "div",
            {
              style: {
                color: "var(--color-muted)",
                fontSize: 13,
                lineHeight: 1.5,
                marginTop: 4,
                wordBreak: "break-word",
              },
            },
            summary,
          ),
          React.createElement(
            "button",
            {
              type: "button",
              onClick: this.handleRetry,
              style: {
                marginTop: 10,
                border: "1px solid var(--color-border)",
                borderRadius: 9999,
                background: "transparent",
                color: "var(--color-muted)",
                fontSize: 13,
                fontWeight: 500,
                padding: "6px 12px",
                transition: "background-color 150ms ease, color 150ms ease",
              },
              onMouseEnter: (event: React.MouseEvent<HTMLButtonElement>) => {
                event.currentTarget.style.background = "var(--color-surface)"
                event.currentTarget.style.color = "var(--color-ink)"
              },
              onMouseLeave: (event: React.MouseEvent<HTMLButtonElement>) => {
                event.currentTarget.style.background = "transparent"
                event.currentTarget.style.color = "var(--color-muted)"
              },
            },
            "Retry",
          ),
        ),
      ),
    )
  }
}
