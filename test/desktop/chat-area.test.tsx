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
})
