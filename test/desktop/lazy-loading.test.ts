import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

describe("lazy loading source analysis", () => {
  test("Message.tsx uses React.lazy and Suspense with ErrorBoundary for MarkdownText", () => {
    const messageSource = readFileSync(join(import.meta.dir, "../../src/desktop/src/components/Message.tsx"), "utf8")
    
    expect(messageSource).toContain("React.lazy(() => import(\"./MarkdownText\"))")
    expect(messageSource).toContain("<Suspense")
    expect(messageSource).toContain("pulse-placeholder")
    expect(messageSource).toContain("<ErrorBoundary>")
  })
})
