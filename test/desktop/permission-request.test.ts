import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop permission request", () => {
  test("uses linear card-style design with CSS variables", () => {
    const source = readFileSync("src/desktop/src/components/PermissionRequest.tsx", "utf8")

    expect(source).toContain("border-border bg-surface")
    expect(source).toContain("px-[20px] py-[16px]")
    expect(source).toContain("rounded-[12px]")

    expect(source).toContain("font-semibold text-ink")
    expect(source).toContain("{request.toolName}")

    expect(source).toContain("slice(0, 80)")
    expect(source).toContain("font-mono text-[13px] text-muted")

    expect(source).toContain("bg-transparent")
    expect(source).toContain("bg-accent")
    expect(source).toContain("text-paper")
  })

  test("calculates risk indicator based on tool name", () => {
    const source = readFileSync("src/desktop/src/components/PermissionRequest.tsx", "utf8")

    expect(source).toContain("function getRiskIndicator(toolName: string)")
    expect(source).toContain("bg-danger")
    expect(source).toContain("bg-highlight")
    expect(source).toContain("bg-success")
    
    expect(source).toContain("w-[3px]")
    expect(source).toContain("${risk.colorClass}")
  })
})
