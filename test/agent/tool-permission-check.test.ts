import { describe, expect, test } from "bun:test"
import { filterToolsForAgent, type AgentProfile } from "../../src/agent"
import {
  buildToolDeniedMessage,
  isToolAllowedForAgent,
} from "../../src/agent/application/tool-permission-check"
import type { ToolDefinition } from "../../src/tool"

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Mock tool ${name}`,
    inputSchema: undefined,
    async execute() {
      return { output: "" }
    },
  }
}

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "plan",
    ...overrides,
  }
}

describe("tool permission check", () => {
  test("blocks exact and wildcard disallowed tool patterns for main agents", () => {
    const profile = makeProfile({ disallowedTools: ["shell", "lsp_*"] })

    expect(isToolAllowedForAgent("shell", profile)).toBe(false)
    expect(isToolAllowedForAgent("lsp_symbols", profile)).toBe(false)
    expect(isToolAllowedForAgent("lsp_goto_definition", profile)).toBe(false)
    expect(isToolAllowedForAgent("read", profile)).toBe(true)
  })

  test("builds the model-facing denied tool message", () => {
    expect(buildToolDeniedMessage("shell", "plan")).toBe(
      "Tool 'shell' is not available in plan mode. Switch to default mode to use this tool.",
    )
  })

  test("leaves subagent tool filtering on its existing exact-name behavior", () => {
    const tools = ["read", "lsp_symbols", "lsp_goto_definition", "agent", "skill"].map(makeTool)

    const result = filterToolsForAgent(
      tools,
      makeProfile({
        tools: ["*"],
        disallowedTools: ["lsp_*"],
      }),
    )

    expect(result.map((tool) => tool.name)).toEqual([
      "read",
      "lsp_symbols",
      "lsp_goto_definition",
    ])
  })
})
