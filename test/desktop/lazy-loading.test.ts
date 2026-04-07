import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"

describe("lazy loading source analysis", () => {
  test("Message.tsx uses React.lazy and Suspense with ErrorBoundary for MarkdownText", () => {
    const messageSource = readFileSync("src/desktop/src/components/Message.tsx", "utf8")
    
    expect(messageSource).toContain("React.lazy(() => import(\"./MarkdownText\"))")
    expect(messageSource).toContain("React.lazy(() => import(\"./ToolDetails\"))")
    expect(messageSource).toContain("<Suspense")
    expect(messageSource).toContain("pulse-placeholder")
    expect(messageSource).toContain("<ErrorBoundary>")
  })
})
