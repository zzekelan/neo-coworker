import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop chat area", () => {
  test("uses a normal transcript viewport without smooth-scroll styling", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("overflow-y-auto px-4 md:px-8")
    expect(source).not.toContain("scroll-smooth")
  })

  test("keeps the chat header edge aligned with the sidebar chrome", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("chrome-edge-bottom sticky top-0 z-10 flex h-14")
    expect(source).toContain("items-center justify-between bg-paper px-4 md:px-6")
  })

  test("keeps no-session empty state on the same header and bottom-inset rhythm", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("if (!sessionSummary)")
    expect(source).toContain("hasSessions ? (")
    expect(source).toContain("{text.chat.selectSession}")
    expect(source).toContain("TRANSCRIPT_BOTTOM_SAFE_AREA")
    expect(source).toContain("style={{ paddingBottom: bottomCardHeight + TRANSCRIPT_BOTTOM_SAFE_AREA }}")
    expect(source).toContain("offsetClassName=\"translate-y-2\"")
    expect(source).not.toContain("absolute top-4 left-4")
  })

  test("anchors empty-state icons independently from text and actions", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("absolute top-1/2 left-1/2 w-full max-w-md -translate-x-1/2 -translate-y-8")
    expect(source).toContain("flex flex-col items-center justify-center")
  })

  test("sizes the transcript bottom inset to match the input card height", () => {
    const chatSource = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")
    const vtSource = readFileSync("src/desktop/src/components/VirtualTranscript.tsx", "utf8")

    expect(chatSource).toContain("bottomCardRef")
    expect(chatSource).toContain("ResizeObserver")
    expect(chatSource).toContain("const TRANSCRIPT_BOTTOM_SAFE_AREA = 42")
    expect(chatSource).toContain("bottomInset={bottomCardHeight + TRANSCRIPT_BOTTOM_SAFE_AREA}")
    expect(chatSource).toContain("scrollButtonOffset={bottomCardHeight + 16}")
    expect(chatSource).not.toContain("pb-32")

    expect(vtSource).toContain("bottomInset")
    expect(vtSource).toContain("transcript-bottom-spacer")
    expect(vtSource).toContain("style={{ height: bottomInset }}")
    expect(vtSource).not.toContain("paddingBottom: bottomInset")
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

    expect(chatSource).not.toContain("getTranscriptItemBottomPadding")

    expect(messageSource).toContain("initial={false}")
    expect(messageSource).not.toContain("initial={{ opacity: 0, y: 10 }}")
    expect(messageSource).not.toContain("\"mb-6 flex w-full flex-col\"")
  })

  test("keeps transcript messages slightly narrower than the composer", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain('<div className="mx-auto max-w-[54rem]">')
    expect(source).toContain('className="pointer-events-auto relative mx-auto max-w-4xl bg-paper"')
    expect(source).not.toContain("content-fade-top")
    expect(source).not.toContain('<div className="w-full">')
  })

  test("keeps the composer and footer opaque while the agent is running", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain('className="pointer-events-none absolute right-0 bottom-0 left-0 bg-paper px-4 pb-1.5"')
    expect(source).toContain('className="pointer-events-auto relative mx-auto max-w-4xl bg-paper"')
    expect(source).toContain('className="mt-1.5 flex h-6 items-center justify-between px-1 text-[11px] text-accent"')
    expect(source).toContain('? "border-border"')
    expect(source).not.toContain("opacity-80")
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

  test("renders only the first pending permission request as the active card", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("const activePermissionRequest = permissionRequests[0] ?? null")
    expect(source).toContain("activePermissionRequest ? (")
    expect(source).toContain("key={activePermissionRequest.id}")
    expect(source).toContain("request={activePermissionRequest}")
    expect(source).toContain("autoFocus")
    expect(source).toContain("onReply={handlePermissionReply}")
    expect(source).not.toContain("permissionRequests.map(")
  })

  test("keeps live thinking distinct from active tool and terminal run states", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("const hasActiveToolCall = useMemo(")
    expect(source).toContain("const hasActiveReasoningPart = useMemo(")
    expect(source).toContain("const showThinkingIndicator = isRunning && !hasActiveToolCall && !hasActiveReasoningPart")
    expect(source).toContain("aria-label={text.message.thinking}")
    expect(source).toContain("{text.message.thinking}")
    expect(source).not.toContain("{text.chat.thinking}")
    expect(source).toContain('const footerRunStatus = activeRunStatus === "running" || activeRunStatus === "queued" ? null : activeRunStatus')
    expect(source).toContain("<RunStatusDot status={footerRunStatus} />")
    expect(source).toContain("function hasPendingToolCall(")
    expect(source).toContain("function hasVisibleReasoningPart(")
    expect(source).toContain("isActiveRunMessage={message.runId === activeRunId && isRunning}")
    expect(source).toContain("waitingPermissionToolName={")
    expect(source).toContain("function RunFinishedNotice(")
    expect(source).toContain("text.chat.runFinishedCancelled")
  })
})
