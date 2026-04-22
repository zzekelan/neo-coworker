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

  test("renders reasoning parts visible-by-default with a collapsible affordance", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).toContain('part.type === "reasoning"')
    expect(source).toContain("<ReasoningBlock")
    expect(source).toContain("const ReasoningBlock")
    expect(source).toContain("useState(true)")
    expect(source).toContain("labels.message.reasoning")
    expect(source).toContain("aria-expanded={isExpanded}")
  })
})
