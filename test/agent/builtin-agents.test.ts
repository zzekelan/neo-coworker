import { describe, expect, test } from "bun:test"
import {
  BUILTIN_AGENTS,
  getBuiltinAgent,
  listPrimaryBuiltinAgents,
} from "../../src/agent/domain/builtin-agents"

describe("builtin agents", () => {
  test("defines the default primary agent", () => {
    const agent = BUILTIN_AGENTS.default

    expect(agent).toBeDefined()
    expect(agent).toEqual({
      name: "default",
      description: "General-purpose assistant",
      isPrimary: true,
      temperature: 1,
      skills: [],
    })
    expect(agent.disallowedTools).toBeUndefined()
    expect(agent.systemPromptOverride).toBeUndefined()
  })

  test("defines the plan primary agent with read-only restrictions", () => {
    const agent = BUILTIN_AGENTS.plan

    expect(agent).toBeDefined()
    expect(agent.name).toBe("plan")
    expect(agent.description).toBe("Strategic planning mode — read-only, no code modifications")
    expect(agent.isPrimary).toBe(true)
    expect(agent.temperature).toBe(1)
    expect(agent.skills).toEqual([])
    expect(agent.disallowedTools).toEqual([
      "shell",
      "edit",
      "write",
      "memory_add",
      "memory_replace",
      "memory_remove",
      "create_skill",
      "patch_skill",
      "delete_skill",
    ])
    expect(agent.instructions).toContain("strategic planning mode")
    expect(agent.instructions).toContain("Do not make code changes")
    expect(agent.instructions?.trim().length).toBeGreaterThan(0)
    expect(agent.systemPromptOverride).toBeUndefined()
  })

  test("lists only the primary builtin agents", () => {
    const primaryAgents = listPrimaryBuiltinAgents()

    expect(primaryAgents.map((agent) => agent.name)).toEqual(["default", "plan", "deep-research"])
    expect(primaryAgents.every((agent) => agent.isPrimary === true)).toBe(true)
  })

  test("keeps subagent definitions untouched", () => {
    expect(BUILTIN_AGENTS.explore).toEqual({
      name: "explore",
      description: "Read-only exploration agent for codebase analysis",
      tools: [
        "read",
        "grep",
        "glob",
        "lsp_symbols",
        "lsp_goto_definition",
        "lsp_find_references",
      ],
      parallel: true,
      skills: [],
    })

    expect(BUILTIN_AGENTS.websearch).toEqual({
      name: "websearch",
      description: "Web research agent for searching and fetching online information",
      tools: ["websearch", "webfetch"],
      parallel: true,
      skills: [],
    })

    expect(BUILTIN_AGENTS.explore.isPrimary).toBeUndefined()
    expect(BUILTIN_AGENTS.websearch.isPrimary).toBeUndefined()
  })

  test("returns builtin agents by name", () => {
    expect(getBuiltinAgent("default")).toBe(BUILTIN_AGENTS.default)
    expect(getBuiltinAgent("plan")).toBe(BUILTIN_AGENTS.plan)
    expect(getBuiltinAgent("missing")).toBeUndefined()
  })
})
