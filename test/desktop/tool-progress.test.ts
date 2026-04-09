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

  test("should define typing-dot keyframes in CSS for thinking indicator", () => {
    expect(cssSource).toContain("@keyframes typing-dot")
    expect(cssSource).toContain(".animate-typing-dot")
    expect(cssSource).toContain("animation: typing-dot")
  })

  test("should have status indicators in ToolIndicator for pending status", () => {
    expect(messageSource).toContain("animate-breathe bg-highlight")
    expect(messageSource).toContain("text-success")
    expect(messageSource).toContain("text-danger")
  })

  test("should extract progress text to subtitle in ToolIndicator", () => {
    expect(messageSource).toContain("part.progress ?? describeToolCallSummary")
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
