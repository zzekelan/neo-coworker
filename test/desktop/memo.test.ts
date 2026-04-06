import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop performance optimizations", () => {
  test("Message components use React.memo to prevent unnecessary re-renders", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).toContain("export const Message = React.memo(MessageComponent)")
    expect(source).toContain("const ToolActivityCard: React.FC<")
    expect(source).toMatch(/const ToolActivityCard[\s\S]*?=\s*React\.memo\(/)
    expect(source).toMatch(/const ToolStatusBadge[\s\S]*?=\s*React\.memo\(/)
  })

  test("MarkdownText uses React.memo and useMemo for markdown parse results", () => {
    const source = readFileSync("src/desktop/src/components/MarkdownText.tsx", "utf8")

    expect(source).toMatch(/export const MarkdownText\s*=\s*React\.memo\(/)
    expect(source).toContain("useMemo(() => parseMarkdown(input.text)")
    expect(source).toContain("<ReactMarkdown")
  })

  test("ChatArea stabilizes callbacks using useCallback", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("useCallback(")
    expect(source).toMatch(/const handlePermissionReply\s*=\s*useCallback\(/)
    expect(source).toMatch(/const setDefaultSkill\s*=\s*useCallback\(/)
    expect(source).toMatch(/const handleStartSkill\s*=\s*useCallback\(/)
  })
})