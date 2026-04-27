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

  test("renders reasoning parts collapsed by default with an expandable affordance", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).toContain('part.type === "reasoning"')
    expect(source).toContain("<ReasoningBlock")
    expect(source).toContain("const ReasoningBlock")
    expect(source).toContain("useState(false)")
    expect(source).toContain("labels.message.reasoning")
    expect(source).toContain("aria-expanded={isExpanded}")
    expect(source).toContain("ACTIVITY_ROW_CLASS")
    expect(source).toContain("ACTIVITY_RAIL_CLASS")
    expect(source).toContain("ACTIVITY_LABEL_CLASS")
    expect(source).toContain('className={ACTIVITY_LABEL_CLASS}')
  })

  test("labels reasoning activity as thinking in the desktop transcript", () => {
    const source = readFileSync("src/desktop/src/i18n.tsx", "utf8")

    expect(source).toContain('reasoning: "Thinking"')
    expect(source).toContain('reasoning: "思考"')
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

  test("filters whitespace-only text parts and keeps activity details bounded", () => {
    const messageSource = readFileSync("src/desktop/src/components/Message.tsx", "utf8")
    const detailsSource = readFileSync("src/desktop/src/components/ToolDetails.tsx", "utf8")

    expect(messageSource).toContain('p.type !== "text" || p.text.trim().length > 0')
    expect(messageSource).toContain("p.text.trim().length > 0")
    expect(messageSource).toContain("function compactPath(")
    expect(detailsSource).toContain("max-h-80")
    expect(detailsSource).toContain("overflow-y-auto")
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
