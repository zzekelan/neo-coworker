import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop chat area", () => {
  test("uses a normal transcript viewport without smooth-scroll styling", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("overflow-y-auto px-4 pb-32 md:px-8")
    expect(source).not.toContain("scroll-smooth")
  })

  test("keeps a sticky-bottom guard instead of forcing scroll reset unconditionally", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("shouldStickToBottomRef")
    expect(source).toContain("viewport.scrollTop = viewport.scrollHeight")
    expect(source).toContain("isNearTranscriptBottom")
    expect(source).not.toContain("scrollIntoView")
  })

  test("locks user-driven skill edits while an active run is present", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")
    const panelSource = readFileSync("src/desktop/src/components/SkillPanel.tsx", "utf8")

    expect(source).toContain("const isRunSkillEditingLocked = Boolean(session?.activeRun)")
    expect(source).toContain("if (!sessionSummary || isRunSkillEditingLocked)")
    expect(panelSource).toContain("text.skillPanel.locked")
  })

  test("restores sticky-bottom behavior when sending messages or replying to permissions", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("const stickTranscriptToBottom = () => {")
    expect(source).toContain("shouldStickToBottomRef.current = true")
    expect(source).toContain("await sessionSkillQueueRef.current.queue?.flush()")
    expect(source).toContain("const sent = await onSendMessage(nextInput)")
    expect(source).toContain("setInput(\"\")")
    expect(source).toContain("const handlePermissionReply = (requestId: string, decision: \"allow\" | \"deny\") => {")
    expect(source).toContain("void onReplyPermission(requestId, decision)")
  })

  test("closes the skill panel on outside click and defers Enter submission during IME composition", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("const skillPanelShellRef = useRef<HTMLDivElement>(null)")
    expect(source).toContain("window.addEventListener(\"mousedown\", handlePointerDown)")
    expect(source).toContain("setIsSkillPanelOpen(false)")
    expect(source).toContain("onCompositionStart={() => setIsComposing(true)}")
    expect(source).toContain("onCompositionEnd={() => setIsComposing(false)}")
    expect(source).toContain("!event.nativeEvent.isComposing")
    expect(source).toContain("disabled={!input.trim() || isComposing || isSubmittingMessage}")
  })
})
