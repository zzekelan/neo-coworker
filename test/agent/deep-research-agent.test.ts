import { describe, expect, test } from "bun:test"
import {
  BUILTIN_AGENTS,
  getBuiltinAgent,
  listPrimaryBuiltinAgents,
} from "../../src/agent/domain/builtin-agents"
import { parseCliCommand } from "../../src/cli/cli"
import {
  composeAgentAwarePrompt,
  type DynamicPromptContext,
} from "../../src/orchestration/application/prompt-composer"

const context: DynamicPromptContext = {
  activeSkillNames: [],
  environment: {
    workingDirectory: "/workspace/project",
    isGitRepository: true,
    platform: "linux",
    shell: "bash",
    date: "2026-04-25",
  },
}

describe("deep research builtin agent", () => {
  test("registers Deep Research as a primary builtin agent", () => {
    const agent = getBuiltinAgent("deep-research")

    expect(agent).toBe(BUILTIN_AGENTS["deep-research"])
    expect(agent).toMatchObject({
      name: "deep-research",
      description: "Deep Research",
      isPrimary: true,
      skills: ["research/deep-research", "research/finding-synthesis"],
    })
    expect(agent?.tools).toBeUndefined()
    expect(agent?.systemPromptOverride).toBeUndefined()
    expect(listPrimaryBuiltinAgents().map((profile) => profile.name)).toEqual([
      "general",
      "plan",
      "deep-research",
    ])
  })

  test("adds file-only Deep Research artifact workflow instructions to the prompt", () => {
    const prompt = composeAgentAwarePrompt(context, getBuiltinAgent("deep-research"))

    expect(prompt).toContain("# Deep Research Workflow")
    expect(prompt).toContain(".ncoworker/research")
    expect(prompt).toContain("Claim")
    expect(prompt).toContain("Evidence")
    expect(prompt).toContain("source acceptance")
    expect(prompt).toContain("source rejection")
    expect(prompt).toContain("caveats")
    expect(prompt).toContain("topic reuse")
    expect(prompt).toContain("topic update")
    expect(prompt).toContain("Only the primary Deep Research agent writes research artifacts")
    expect(prompt).toContain("Subagents return structured/source notes only")
    expect(prompt).toContain("must not write `.ncoworker/research/**`")
  })

  test("keeps Deep Research instructions scoped away from extra UI and browser tooling", () => {
    const instructions = getBuiltinAgent("deep-research")?.instructions ?? ""

    expect(instructions).not.toMatch(/playwright/i)
    expect(instructions).not.toMatch(/browser/i)
    expect(instructions).not.toMatch(/websearch/i)
  })

  test("accepts deep-research through the existing CLI agent flag parser", () => {
    expect(parseCliCommand(["run", "--agent", "deep-research", "Investigate market data"])).toEqual({
      command: "run",
      prompt: "Investigate market data",
      agent: "deep-research",
      sessionId: undefined,
    })
    expect(parseCliCommand(["chat", "--agent=deep-research"])).toEqual({
      command: "chat",
      agent: "deep-research",
      sessionId: undefined,
    })
  })
})
