import { describe, expect, test } from "bun:test"
import {
  BUILTIN_AGENTS,
  getBuiltinAgent,
  listPrimaryBuiltinAgents,
} from "../../src/agent/domain/builtin-agents"

describe("builtin agents", () => {
  test("defines the general primary agent", () => {
    const agent = BUILTIN_AGENTS.general

    expect(agent).toBeDefined()
    expect(agent).toEqual({
      name: "general",
      displayName: "General",
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
    expect(agent.displayName).toBe("Plan")
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

    expect(primaryAgents.map((agent) => agent.name)).toEqual(["general", "plan", "deep-research"])
    expect(primaryAgents.map((agent) => agent.displayName)).toEqual([
      "General",
      "Plan",
      "Deep Research",
    ])
    expect(primaryAgents.every((agent) => agent.isPrimary === true)).toBe(true)
  })

  test("defines source researcher as a hidden source-note skill subagent", () => {
    const agent = BUILTIN_AGENTS["source-researcher"]

    expect(agent).toBeDefined()
    expect(agent.name).toBe("source-researcher")
    expect(agent.displayName).toBe("Source Researcher")
    expect(agent.description).toBe("Source note collector")
    expect(agent.skills).toEqual(["source-note"])
    expect(agent.isPrimary).toBeUndefined()
    expect(agent.tools).toEqual(["read", "grep", "glob", "webfetch", "websearch", "get_current_datetime"])
    expect(agent.tools?.filter((tool) => tool === "websearch")).toHaveLength(1)
    expect(agent.tools).not.toContain("codesearch")
    expect(agent.tools).not.toContain("shell")
    expect(agent.tools).not.toContain("bash")
    expect(agent.tools).not.toContain("write")
    expect(agent.tools).not.toContain("edit")
    expect(agent.tools).not.toContain("agent")
    expect(agent.tools).not.toContain("skill")
    expect(agent.tools).not.toContain("plan_exit")
    expect(agent.parallel).toBe(true)
    expect(agent.instructions).toContain("source-note")
    expect(agent.instructions).not.toContain("research/source-note")
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
    expect(getBuiltinAgent("general")).toBe(BUILTIN_AGENTS.general)
    expect(getBuiltinAgent("default")).toBeUndefined()
    expect(getBuiltinAgent("source-researcher")).toBe(BUILTIN_AGENTS["source-researcher"])
    expect(getBuiltinAgent("source-note")).toBeUndefined()
    expect(getBuiltinAgent("plan")).toBe(BUILTIN_AGENTS.plan)
    expect(getBuiltinAgent("missing")).toBeUndefined()
  })
})
