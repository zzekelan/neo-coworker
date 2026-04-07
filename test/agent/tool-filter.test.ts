import { describe, expect, test } from "bun:test"
import {
  filterToolsForAgent,
  loadSkillsForAgent,
  type AgentProfile,
} from "../../src/agent"
import type { OrchestrationLoadedSkill, OrchestrationSkillPort } from "../../src/orchestration"
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
    name: "helper",
    ...overrides,
  }
}

describe("tool filter", () => {
  const parentTools = ["read", "grep", "write", "edit", "shell", "agent", "skill"].map(makeTool)

  test("keeps only explicitly whitelisted parent tools", () => {
    const result = filterToolsForAgent(parentTools, makeProfile({ tools: ["read", "grep"] }))

    expect(result.map((tool) => tool.name)).toEqual(["read", "grep"])
  })

  test("inherits all parent tools except agent and skill in wildcard mode", () => {
    const result = filterToolsForAgent(parentTools, makeProfile({ tools: ["*"] }))

    expect(result.map((tool) => tool.name)).toEqual(["read", "grep", "write", "edit", "shell"])
  })

  test("inherits all parent tools except agent and skill when tools is undefined", () => {
    const result = filterToolsForAgent(parentTools, makeProfile())

    expect(result.map((tool) => tool.name)).toEqual(["read", "grep", "write", "edit", "shell"])
  })

  test("inherits all parent tools except agent and skill when tools is an empty array", () => {
    const result = filterToolsForAgent(parentTools, makeProfile({ tools: [] }))

    expect(result.map((tool) => tool.name)).toEqual(["read", "grep", "write", "edit", "shell"])
  })

  test("applies disallowedTools after parent inheritance", () => {
    const result = filterToolsForAgent(
      parentTools,
      makeProfile({ tools: ["*"], disallowedTools: ["shell"] }),
    )

    expect(result.map((tool) => tool.name)).toEqual(["read", "grep", "write", "edit"])
  })

  test("always excludes the agent tool even when explicitly whitelisted", () => {
    const result = filterToolsForAgent(parentTools, makeProfile({ tools: ["read", "agent"] }))

    expect(result.map((tool) => tool.name)).toEqual(["read"])
  })

  test("always excludes the skill tool even when explicitly whitelisted", () => {
    const result = filterToolsForAgent(parentTools, makeProfile({ tools: ["read", "skill"] }))

    expect(result.map((tool) => tool.name)).toEqual(["read"])
  })

  test("returns no injected tools when the agent skill list is empty", async () => {
    const calls: string[] = []
    const skillService: OrchestrationSkillPort = {
      async listCatalog() {
        return []
      },
      async loadSkill(input) {
        calls.push(input.name)
        return {
          name: input.name,
          description: `Skill ${input.name}`,
          path: `/skills/${input.name}`,
          instructions: "",
        } as never
      },
    }

    const result = await loadSkillsForAgent(makeProfile({ skills: [] }), skillService)

    expect(result).toEqual([])
    expect(calls).toEqual([])
  })

  test("loads only whitelisted skills and dedupes injected tools by name", async () => {
    const loadedNames: string[] = []
    const skillService: OrchestrationSkillPort = {
      async listCatalog() {
        return [
          { name: "code-review", description: "Code review", path: "/skills/code-review" },
          { name: "security", description: "Security", path: "/skills/security" },
        ]
      },
      async loadSkill(input) {
        loadedNames.push(input.name)

        const skill: OrchestrationLoadedSkill & {
          description: string
          injectedTools: ToolDefinition[]
        } = {
          name: input.name,
          description: `Skill ${input.name}`,
          path: `/skills/${input.name}`,
          instructions: `Instructions for ${input.name}`,
          injectedTools:
            input.name === "code-review"
              ? [makeTool("code-review-tool"), makeTool("shared-tool")]
              : [makeTool("security-tool"), makeTool("shared-tool")],
        }

        return skill
      },
    }

    const result = await loadSkillsForAgent(
      makeProfile({ skills: ["code-review", "code-review", "security", " "] }),
      skillService,
    )

    expect(loadedNames).toEqual(["code-review", "security"])
    expect(result.map((tool) => tool.name)).toEqual([
      "code-review-tool",
      "shared-tool",
      "security-tool",
    ])
  })
})
