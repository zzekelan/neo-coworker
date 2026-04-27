import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop message", () => {
  test("uses a shared expandable renderer for noisy tool input and result fields", () => {
    const messageSource = readFileSync("src/desktop/src/components/Message.tsx", "utf8")
    const detailsSource = readFileSync("src/desktop/src/components/ToolDetails.tsx", "utf8")

    expect(messageSource).toContain('React.lazy(() => import("./ToolDetails"))')
    expect(messageSource).toContain("<ToolDetails")
    expect(detailsSource).toContain("const HIDDEN_TOOL_KEYS = new Set([")
    expect(detailsSource).toContain("\"content\"")
    expect(detailsSource).toContain("\"inputText\"")
    expect(detailsSource).toContain("fieldName={detail.label} value={detail.value}")
    expect(detailsSource).toContain("fieldName={fieldName} value={value}")
    expect(detailsSource).toContain("const ExpandableFieldValue")
    expect(detailsSource).toContain("{isExpanded ? text.message.showLess : text.message.showMore}")
  })

  test("renders compaction_boundary parts using the CompactionDivider component", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    // Verify the import
    expect(source).toContain('import { CompactionDivider }')

    // Verify the part type check
    expect(source).toContain('part.type === "compaction_boundary"')

    // Verify it passes the required props
    expect(source).toContain("part.tokensBefore")
    expect(source).toContain("part.tokensAfter")
  })

  test("collapses large patch text and long multiline values by default", () => {
    const source = readFileSync("src/desktop/src/components/ToolDetails.tsx", "utf8")

    expect(source).toContain("const DEFAULT_COLLAPSED_CHAR_LIMIT = 280")
    expect(source).toContain("const DEFAULT_COLLAPSED_LINE_LIMIT = 8")
    expect(source).toContain("const isLargePatchText = /^diff --git |^@@ |^\\+\\+\\+ |^--- /m.test(value)")
    expect(source).toContain("return wasTruncated ? `${limitedText}\\n...` : limitedText")
  })

  test("renders completed reasoning collapsed by default and live thinking expanded with the prior label", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).toContain('part.type === "reasoning"')
    expect(source).toContain("<ReasoningBlock")
    expect(source).toContain("const ReasoningBlock")
    expect(source).toContain("isActiveRunMessage?: boolean")
    expect(source).toContain("isFinalRunAssistantTextMessage?: boolean")
    expect(source).toContain("foldActivityAfterNextReasoning?: boolean")
    expect(source).toContain("foldActivityImmediately?: boolean")
    expect(source).toContain("const isLiveReasoning = isActiveRunMessage && partIndex === latestRenderablePartIndex")
    expect(source).toContain("isLive={isLiveReasoning}")
    expect(source).not.toContain("forceActivitySummary={isActiveRunMessage && !isLiveReasoning}")
    expect(source).not.toContain("isRunActiveMessage?: boolean")
    expect(source).toContain("const [foldBeforePartIndex, setFoldBeforePartIndex] = useState<number | null>(null)")
    expect(source).toContain("const [canFoldAfterNextReasoning, setCanFoldAfterNextReasoning] = useState(false)")
    expect(source).toContain("const nextReasoningFoldTimerRef = useRef<number | null>(null)")
    expect(source).toContain("const delayedFoldBeforePartIndex = foldBeforePartIndex !== null")
    expect(source).toContain("const effectiveFoldBeforePartIndex = foldActivityImmediately")
    expect(source).toContain("const latestRenderablePartIndex = renderableParts.length - 1")
    expect(source).not.toContain("renderablePartCount")
    expect(source).toContain("foldActivityImmediately")
    expect(source).toContain(" ? Number.POSITIVE_INFINITY")
    expect(source).toContain("const shouldShowCompletedActivityGroup = foldedRenderItems.length > 0")
    expect(source).toContain("const finalVisibleTextPartIndex = useMemo(")
    expect(source).toContain("findLastTextPartIndex(renderableParts)")
    expect(source).toContain("function shouldFoldRunItem(")
    expect(source).toContain("renderItemContainsPartIndex(item, finalVisibleTextPartIndex)")
    expect(source).toContain("isPendingToolRenderItem(item)")
    expect(source).toContain("function isPendingToolRenderItem(")
    expect(source).toContain("item.part.status !== \"success\"")
    expect(source).toContain("getRenderItemEndIndex(item) < foldBeforePartIndex")
    expect(source).toContain("function createAssistantTextParts(")
    expect(source).toContain("setFoldBeforePartIndex((current) => Math.max(current ?? -1, liveReasoningPartIndex))")
    expect(source).toContain("nextReasoningFoldTimerRef.current = window.setTimeout")
    expect(source).toContain("nextReasoningFoldTimerRef.current = null")
    expect(source).toContain("setCanFoldAfterNextReasoning(true)")
    expect(source).not.toContain("if (!foldActivityAfterNextReasoning) {\n      setCanFoldAfterNextReasoning(false)")
    expect(source).toContain("}, 2000)")
    expect(source).toContain("const visibleRenderItems = useMemo(")
    expect(source).toContain("const completedActivityGroup = shouldShowCompletedActivityGroup ? (")
    expect(source).toContain("label={buildCompletedActivityLabel(")
    expect(source).toContain("visibleRenderItems.map((item) => (")
    expect(source.indexOf("{completedActivityGroup}")).toBeLessThan(source.indexOf("visibleRenderItems.map((item) => ("))
    expect(source).not.toContain("message.runDurationMs")
    expect(source).toContain("labels.message.completedRunActivity(duration, toolNames)")
    expect(source).toContain("function collectActivityToolNames(")
    expect(source).toContain("const [canShowCompletedSummaryLabel, setCanShowCompletedSummaryLabel] = useState(!isLive)")
    expect(source).toContain("setCanShowCompletedSummaryLabel(true)")
    expect(source).toContain("useState(isLive)")
    expect(source).toContain("setIsExpanded(true)")
    expect(source).toContain("setIsExpanded(false)")
    expect(source).toContain("labels.message.reasoning")
    expect(source).toContain("labels.message.thinking")
    expect(source).toContain("labels.message.completedActivity")
    expect(source).toContain("labels.message.completedRunActivity")
    expect(source).toContain("labels.message.formatDuration")
    expect(source).not.toContain("useReasoningTitleOnly")
    expect(source).not.toContain("forceActivitySummary")
    expect(source).toContain("const contentRef = useRef<HTMLDivElement | null>(null)")
    expect(source).toContain("window.requestAnimationFrame")
    expect(source).toContain("node.scrollTop = node.scrollHeight")
    expect(source).toContain("}, 1000)")
    expect(source).toContain("aria-expanded={isExpanded}")
    expect(source).toContain("aria-live={isLive ? \"polite\" : undefined}")
    expect(source).toContain("THINKING_LABEL_CLASS")
    expect(source).toContain("isLive ? (")
    expect(source).toContain("animate-symbol-spin")
    expect(source).toContain("className=\"h-3 w-3 max-w-none shrink-0 animate-symbol-spin text-highlight\"")
    expect(source).toContain('className="py-1 pr-2"')
    expect(source).toContain("ACTIVITY_CHEVRON_SLOT_CLASS")
    expect(source).toContain('className="group flex w-full cursor-pointer items-center gap-2 rounded-sm text-left focus-visible:ring-1 focus-visible:ring-highlight/40 focus-visible:outline-none"')
    expect(source).toContain('className={cn("min-w-0 flex-1 text-left", THINKING_LABEL_CLASS)}')
    expect(source).toContain("className={ACTIVITY_CHEVRON_SLOT_CLASS}")
    expect(source).not.toContain("ACTIVITY_RAIL_CLASS")
  })

  test("labels completed reasoning as reasoning instead of live thinking", () => {
    const source = readFileSync("src/desktop/src/i18n.tsx", "utf8")

    expect(source).toContain('reasoning: "Reasoning"')
    expect(source).toContain('reasoning: "推理摘要"')
    expect(source).toContain('thinking: "Thinking"')
    expect(source).toContain('thinking: "正在思考"')
    expect(source).toContain("return duration ? `已运行${label}（${duration}）` : `已运行${label}`")
    expect(source).toContain("completedRunActivity(duration: string | null, toolNames: string[])")
    expect(source).toContain("return `${ranText}，调用了 ${toolNames.join(\"、\")} 工具`")
    expect(source).toContain("return `${(durationMs / 1000).toFixed(1)} 秒`")
    expect(source).not.toContain("Math.max(0, Math.round(durationMs))}ms")
    expect(source).not.toContain('reasoning: "Thinking"')
  })

  test("keeps transcript timestamps sparse and visually quiet", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).toContain("const TIMESTAMP_VISIBLE_GAP_MS = 5 * 60 * 1000")
    expect(source).toContain("function shouldShowTimestamp(")
    expect(source).toContain("return currentTime - previousTime >= TIMESTAMP_VISIBLE_GAP_MS")
    expect(source).toContain("function formatTimestampLabel(")
    expect(source).toContain("date.toLocaleTimeString([], timeFormat)")
    expect(source).toContain('className="my-2 flex w-full justify-center"')
    expect(source).not.toContain("font-mono text-[11px] font-medium uppercase tracking-[0.08em]")
  })

  test("keeps user copy action out of the message bubble flow", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).toContain('isUser && copyableText && "group/msg"')
    expect(source).toContain('"max-w-[78%] items-end pb-7"')
    expect(source).toContain('"relative rounded-xl rounded-tr-md border border-border/35 bg-surface/65 px-4 py-2.5 text-ink"')
    expect(source).toContain('className="absolute right-2 top-[calc(100%+0.25rem)]"')
    expect(source).not.toContain('className="mt-2 self-end"')
  })

  test("does not render copy actions for assistant text", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")
    const assistantTextPart = source.slice(
      source.indexOf("function AssistantTextPart"),
      source.indexOf("const MessagePartRenderer"),
    )

    expect(source).toContain("function AssistantTextPart")
    expect(source).toContain("<AssistantTextPart")
    expect(source).not.toContain("TextPartWithCopy")
    expect(assistantTextPart).not.toContain("CopyMessageButton")
    expect(assistantTextPart).not.toContain("copyLabel")
  })

  test("keeps agent tool rows aligned without a separate activity rail", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).not.toContain('isAgent && "ml-2"')
    expect(source).not.toContain("before:absolute before:left")
  })

  test("renders tool rows without leading dot markers", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).not.toContain("ACTIVITY_MARKER_CLASS")
    expect(source).not.toContain("isAgentTool(")
  })

  test("keeps top-level tool labels aligned with thinking and assistant text", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).toContain(`const ACTIVITY_ROW_CLASS =
  "relative min-h-7 pr-2 py-1 text-left transition-colors hover:bg-surface/35"`)
    expect(source).toContain('className={cn("w-full", isUser ? "space-y-2" : "space-y-0")}')
    expect(source).not.toContain("ACTIVITY_RAIL_CLASS")
    expect(source).not.toContain("relative min-h-7 pl-6 pr-2")
    expect(source).not.toContain('isUser ? "space-y-2" : "space-y-1.5"')
  })

  test("keeps grouped tool children on the same vertical rhythm as tool rows", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).toContain('className="ml-2 pl-4"')
    expect(source).not.toContain('className="ml-2 mt-1 pl-4"')
  })

  test("summarizes skill tool rows with the affected skill name", () => {
    const messageSource = readFileSync("src/desktop/src/components/Message.tsx", "utf8")
    const i18nSource = readFileSync("src/desktop/src/i18n.tsx", "utf8")

    expect(messageSource).toContain("function describeCompletedSkillSummary(")
    expect(messageSource).toContain('resultOutput?.match(/^Activated skill\\s+(.+)$/i)')
    expect(messageSource).toContain('readRecordString(parsedInput, "name")')
    expect(i18nSource).toContain("completedSkillActivation(name: string): string")
    expect(i18nSource).toContain('completedSkillList: "Listed skills"')
    expect(i18nSource).toContain('completedSkillList: "列出了技能"')
  })

  test("filters whitespace-only text parts and keeps activity details bounded", () => {
    const messageSource = readFileSync("src/desktop/src/components/Message.tsx", "utf8")
    const detailsSource = readFileSync("src/desktop/src/components/ToolDetails.tsx", "utf8")

    expect(messageSource).toContain('part.type !== "text" || part.text.trim().length > 0')
    expect(messageSource).toContain("p.text.trim().length > 0")
    expect(messageSource).toContain("function compactPath(")
    expect(detailsSource).toContain("max-h-64")
    expect(detailsSource).toContain("overflow-y-auto")
    expect(detailsSource).toContain("border-l border-border/70")
  })

  test("does not render structured lifecycle diagnostics in the chat transcript", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")
    const i18nSource = readFileSync("src/desktop/src/i18n.tsx", "utf8")

    expect(source).not.toContain('part.type === "lifecycle"')
    expect(source).not.toContain("<LifecycleDiagnostic")
    expect(source).not.toContain("describeLifecycleTitle")
    expect(i18nSource).not.toContain("loadingSkill(name: string)")
    expect(i18nSource).not.toContain("failedToLoadSkill(name: string)")
  })
})
