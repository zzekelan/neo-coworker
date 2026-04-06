import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop error boundary", () => {
  const source = readFileSync("src/desktop/src/components/ErrorBoundary.ts", "utf8")

  test("is a React class component with getDerivedStateFromError", () => {
    expect(source).toContain("extends React.Component")
    expect(source).toContain("getDerivedStateFromError")
    expect(source).toContain("componentDidCatch")
  })

  test("exposes data-testid error-boundary-fallback on the fallback container", () => {
    expect(source).toContain("data-testid")
    expect(source).toContain("error-boundary-fallback")
  })

  test("shows Something went wrong text in fallback", () => {
    expect(source).toContain("Something went wrong")
  })

  test("has a Retry button that resets state", () => {
    expect(source).toContain("Retry")
    expect(source).toContain("handleRetry")
    expect(source).toContain("hasError: false")
  })

  test("accepts fallback and onError props", () => {
    expect(source).toContain("fallback")
    expect(source).toContain("onError")
  })

  test("uses CSS variables for colors, no hardcoded hex", () => {
    expect(source).toContain("var(--color-surface)")
    expect(source).toContain("var(--color-border)")
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}/)
  })
})
