import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop message", () => {
  test("uses a shared expandable renderer for noisy tool input and result fields", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).toContain("const HIDDEN_TOOL_KEYS = new Set([")
    expect(source).toContain("\"command\"")
    expect(source).toContain("\"content\"")
    expect(source).toContain("\"inputText\"")
    expect(source).toContain("fieldName={detail.label} value={detail.value}")
    expect(source).toContain("fieldName={fieldName} value={value}")
    expect(source).toContain("const ExpandableFieldValue")
    expect(source).toContain("{isExpanded ? text.message.showLess : text.message.showMore}")
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
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).toContain("const DEFAULT_COLLAPSED_CHAR_LIMIT = 280")
    expect(source).toContain("const DEFAULT_COLLAPSED_LINE_LIMIT = 8")
    expect(source).toContain("const isLargePatchText = /^diff --git |^@@ |^\\+\\+\\+ |^--- /m.test(value)")
    expect(source).toContain("return wasTruncated ? `${limitedText}\\n...` : limitedText")
  })
})
