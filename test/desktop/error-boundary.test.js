import { describe, expect, test } from "bun:test"
import React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { ErrorBoundary } from "../../src/desktop/src/components/ErrorBoundary"

describe("desktop error boundary", () => {
  test("renders children normally when no error occurs", () => {
    const container = document.createElement("div")
    const root = createRoot(container)

    act(() => {
      root.render(
        React.createElement(
          ErrorBoundary,
          null,
          React.createElement("span", { "data-testid": "healthy-child" }, "OK"),
        ),
      )
    })

    expect(container.textContent).toContain("OK")
    expect(container.querySelector('[data-testid="error-boundary-fallback"]')).toBeNull()
    root.unmount()
  })

  test("shows fallback when child throws and retries after reset", () => {
    const container = document.createElement("div")
    const root = createRoot(container)
    let shouldThrow = true
    let errorCount = 0

    function ProblemChild() {
      if (shouldThrow) {
        throw new Error("Boom from child")
      }

      return React.createElement("span", { "data-testid": "recovered-child" }, "Recovered")
    }

    act(() => {
      root.render(
        React.createElement(ErrorBoundary, {
          onError: () => {
            errorCount += 1
          },
          children: React.createElement(ProblemChild),
        }),
      )
    })

    expect(errorCount).toBe(1)
    expect(container.querySelector('[data-testid="error-boundary-fallback"]')).not.toBeNull()
    expect(container.textContent).toContain("Something went wrong")
    expect(container.textContent).toContain("Boom from child")

    shouldThrow = false

    act(() => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(container.querySelector('[data-testid="error-boundary-fallback"]')).toBeNull()
    expect(container.textContent).toContain("Recovered")
    root.unmount()
  })
})
