import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop message", () => {
  test("uses a shared expandable renderer for noisy tool input and result fields", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).toContain("const NOISY_TOOL_FIELDS = new Set([")
    expect(source).toContain("\"command\"")
    expect(source).toContain("\"content\"")
    expect(source).toContain("\"inputText\"")
    expect(source).toContain("<ToolValue fieldName={null} value={part.toolInput} />")
    expect(source).toContain("<ToolValue fieldName={null} value={part.result} />")
    expect(source).toContain("const ExpandableFieldValue")
    expect(source).toContain("{isExpanded ? \"Show less\" : \"Show more\"}")
  })

  test("collapses large patch text and long multiline values by default", () => {
    const source = readFileSync("src/desktop/src/components/Message.tsx", "utf8")

    expect(source).toContain("const DEFAULT_COLLAPSED_CHAR_LIMIT = 280")
    expect(source).toContain("const DEFAULT_COLLAPSED_LINE_LIMIT = 8")
    expect(source).toContain("const isLargePatchText = /^diff --git |^@@ |^\\+\\+\\+ |^--- /m.test(value)")
    expect(source).toContain("return wasTruncated ? `${limitedText}\\n...` : limitedText")
  })
})
