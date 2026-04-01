import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop permission request", () => {
  test("focuses the first pending card and supports keyboard approval shortcuts", () => {
    const source = readFileSync("src/desktop/src/components/PermissionRequest.tsx", "utf8")

    expect(source).toContain("autoFocus?: boolean")
    expect(source).toContain("cardRef.current?.focus()")
    expect(source).toContain("tabIndex={0}")
    expect(source).toContain("if (event.key === \"Enter\")")
    expect(source).toContain("void onReply(request.id, \"allow\")")
    expect(source).toContain("if (event.key === \"Escape\")")
    expect(source).toContain("void onReply(request.id, \"deny\")")
  })
})
