import { describe, expect, test } from "bun:test"
import { buildModelInput } from "../../src/runtime/context"

describe("context builder", () => {
  test("injects system prompt, active skills, tool names, and transcript", () => {
    const input = buildModelInput({
      systemPrompt: "You are the agent runtime.",
      activeSkillInstructions: ["Always explain the diff."],
      tools: [{ name: "read", description: "Read a file" }],
      messages: [{ role: "user", parts: [{ type: "text", text: "inspect README" }] }],
    })

    expect(input.system).toContain("You are the agent runtime.")
    expect(input.system).toContain("Always explain the diff.")
    expect(input.system).toContain("read")
    expect(input.messages).toHaveLength(1)
  })
})
