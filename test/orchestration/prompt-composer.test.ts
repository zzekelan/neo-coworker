import { describe, expect, test } from "bun:test"
import {
  composeSystemPrompt,
  defaultSections,
} from "../../src/orchestration/application/prompt-composer"

describe("orchestration prompt composer", () => {
  test("joins section content with blank lines", () => {
    expect(
      composeSystemPrompt([
        { id: "one", content: "First", isStatic: true },
        { id: "two", content: "Second", isStatic: true },
      ]),
    ).toBe("First\n\nSecond")
  })

  test("defines exactly six default sections", () => {
    expect(defaultSections).toHaveLength(6)
  })

  test("marks the first five default sections as static", () => {
    expect(defaultSections.slice(0, 5).every((section) => section.isStatic)).toBe(true)
  })

  test("marks dynamic context as the only dynamic default section", () => {
    expect(defaultSections[5]).toMatchObject({
      id: "dynamic_context",
      isStatic: false,
    })
  })

  test("includes the identity section in the composed prompt", () => {
    const systemPrompt = composeSystemPrompt(defaultSections)

    expect(systemPrompt).toContain("I help you with everyday work tasks")
  })

  test("keeps backward-compatible default prompt output meaningful and non-empty", () => {
    const systemPrompt = composeSystemPrompt(defaultSections)

    expect(systemPrompt.length).toBeGreaterThan(0)
    expect(systemPrompt).toContain("Do exactly what was asked")
    expect(systemPrompt).toContain("Prefer reversible over irreversible operations")
  })
})
