import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop chat area", () => {
  test("uses a normal transcript viewport without smooth-scroll styling", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("overflow-y-auto px-4 md:px-8")
    expect(source).not.toContain("scroll-smooth")
  })

  test("sizes the transcript bottom inset to match the input card height", () => {
    const chatSource = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")
    const vtSource = readFileSync("src/desktop/src/components/VirtualTranscript.tsx", "utf8")

    expect(chatSource).toContain("bottomCardRef")
    expect(chatSource).toContain("ResizeObserver")
    expect(chatSource).toContain("bottomInset={bottomCardHeight + 16}")
    expect(chatSource).not.toContain("pb-32")

    expect(vtSource).toContain("bottomInset")
    expect(vtSource).toContain("paddingBottom: bottomInset")
  })

  test("delegates sticky-bottom scrolling to VirtualTranscript instead of inlining it", () => {
    const chatSource = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")
    const vtSource = readFileSync("src/desktop/src/components/VirtualTranscript.tsx", "utf8")

    expect(chatSource).toContain("scrollToBottomRef")
    expect(chatSource).toContain("<VirtualTranscript")
    expect(chatSource).not.toContain("scrollIntoView")

    expect(vtSource).toContain("stickToBottomRef")
    expect(vtSource).toContain("distanceFromBottom")
    expect(vtSource).toContain("scrollToIndex")
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

    expect(source).toContain("import { isBusyRunStatus } from \"../busy-state\"")
    expect(source).toContain("const activeRunStatus = session?.activeRun?.status ?? null")
    expect(source).toContain("const isBusy = isBusyRunStatus(activeRunStatus)")
    expect(source).toContain("scrollToBottomRef.current?.()")
    expect(source).toContain("await sessionSkillQueueRef.current.queue?.flush()")
    expect(source).toContain("const sent = await onSendMessage(nextInput)")
    expect(source).toContain("const isInputLocked = isBusy || isSubmittingMessage")
    expect(source).toContain("disabled={isInputLocked}")
    expect(source).toContain("setInput(\"\")")
    expect(source).toContain("const handlePermissionReply = useCallback((requestId: string, decision: \"allow\" | \"deny\") => {")
    expect(source).toContain("return onReplyPermission(requestId, decision)")
  })

  test("keeps virtualized transcript rows stable via @tanstack/react-virtual", () => {
    const vtSource = readFileSync("src/desktop/src/components/VirtualTranscript.tsx", "utf8")
    const chatSource = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")
    const messageSource = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(vtSource).toContain("useVirtualizer")
    expect(vtSource).toContain("@tanstack/react-virtual")
    expect(vtSource).toContain("measureElement")
    expect(vtSource).toContain("style={{ overflowAnchor: \"none\" }}")
    expect(vtSource).toContain("useLayoutEffect")

    expect(chatSource).toContain("paddingBottom: \"1.5rem\"")

    expect(messageSource).toContain("initial={false}")
    expect(messageSource).not.toContain("initial={{ opacity: 0, y: 10 }}")
    expect(messageSource).not.toContain("\"mb-6 flex w-full flex-col\"")
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

  test("renders a context budget bar with adaptive severity when usage data is present", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("contextUsage: DesktopContextUsage | null")
    expect(source).toContain("ContextBudgetBar")
    expect(source).toContain("<ContextBudgetBar usage={contextUsage} />")
    expect(source).toContain("usage: DesktopContextUsage | null")
    expect(source).toContain("const percent = usage")
    expect(source).toContain("const isHigh = percent >= 80")
    expect(source).toContain("const isCritical = percent >= 95")
    expect(source).toContain("bg-danger")
    expect(source).toContain("bg-highlight")
    expect(source).toContain("bg-accent")
    expect(source).toContain("text.chat.contextUsed(percent)")
    expect(source).toContain("style={{ width: `${percent}%` }}")
  })

  test("renders each pending permission request as its own card and only auto-focuses the first", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("permissionRequests.map((request, index) => (")
    expect(source).toContain("key={request.id}")
    expect(source).toContain("request={request}")
    expect(source).toContain("autoFocus={index === 0}")
    expect(source).toContain("onReply={handlePermissionReply}")
  })
})
