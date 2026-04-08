import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

describe("Tool Progress UI (Source Analysis)", () => {
  const testDir = dirname(fileURLToPath(import.meta.url))
  const messageSource = readFileSync(
    join(testDir, "../../src/desktop/src/components/Message.tsx"),
    "utf-8"
  )
  const cssSource = readFileSync(
    join(testDir, "../../src/desktop/src/index.css"),
    "utf-8"
  )
  const appHookSource = readFileSync(
    join(testDir, "../../src/desktop/src/useDesktopApp.ts"),
    "utf-8"
  )
  const apiSource = readFileSync(
    join(testDir, "../../src/desktop/src/api.ts"),
    "utf-8"
  )
  const typesSource = readFileSync(
    join(testDir, "../../src/desktop/src/types.ts"),
    "utf-8"
  )

  test("should define breathe keyframes in CSS", () => {
    expect(cssSource).toContain("@keyframes breathe")
    expect(cssSource).toContain("0%, 100% {")
    expect(cssSource).toContain("opacity: 0.4")
    expect(cssSource).toContain("opacity: 1")
    expect(cssSource).toContain(".animate-breathe")
    expect(cssSource).toContain("animation: breathe 2s ease-in-out infinite")
  })

  test("should have vertical breathing line in ToolActivityCard for pending status", () => {
    expect(messageSource).toContain("w-[2px]")
    expect(messageSource).toContain("animate-breathe bg-accent")
    expect(messageSource).toContain("bg-success opacity-100")
    expect(messageSource).toContain("bg-danger")
  })

  test("should extract progress text to subtitle in ToolActivityCard", () => {
    expect(messageSource).toContain("part.progress ?? describeToolCallSummary")
  })

  test("should classify tools correctly as mutating or read-only", () => {
    expect(messageSource).toContain("isToolMutating")
    expect(messageSource).toContain("bg-highlight/10 text-highlight")
    expect(messageSource).toContain("bg-surface text-muted")
  })

  test("should define ToolProgressEvent type", () => {
    expect(typesSource).toContain('type: "tool.progress"')
  })

  test("should handle tool.progress event in useDesktopApp", () => {
    expect(appHookSource).toContain('event.type === "tool.progress"')
    expect(appHookSource).toContain("updateToolProgress")
  })

  test("should whitelist tool.progress in desktop SSE subscriptions", () => {
    expect(apiSource).toContain("SERVER_EVENT_TYPES")
    expect(apiSource).toContain('"tool.progress"')
  })
})
