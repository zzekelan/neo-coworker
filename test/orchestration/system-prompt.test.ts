import { describe, expect, test } from "bun:test"
import { getBuiltinAgent } from "../../src/agent/domain/builtin-agents"
import type { AgentProfile } from "../../src/agent/public/index.ts"
import {
  buildStaticPromptAssembly,
  composeAgentAwarePrompt,
  composeFullPrompt,
  type DynamicPromptContext,
} from "../../src/orchestration/application/prompt-composer"

const context: DynamicPromptContext = {
  activeSkillNames: ["reviewer"],
  environment: {
    workingDirectory: "/workspace/project",
    isGitRepository: true,
    platform: "linux",
    shell: "bash",
    date: "2026-04-07",
  },
  sessionGuidance: ["Stay within the current workspace root."],
  systemReminders: ["<system-reminder>Skill catalog updated</system-reminder>"],
}

describe("agent-aware system prompt composition", () => {
  test("matches the default composed prompt when no profile is provided", () => {
    expect(composeAgentAwarePrompt(context, undefined)).toBe(composeFullPrompt(context))
  })

  test("appends profile instructions to the default prompt", () => {
    const profile: AgentProfile = {
      name: "reviewer",
      instructions: "Review every diff before accepting it.",
    }

    expect(composeAgentAwarePrompt(context, profile)).toBe(
      `${composeFullPrompt(context)}\n\nReview every diff before accepting it.`,
    )
  })

  test("replaces the default prompt when the profile provides an override", () => {
    const profile: AgentProfile = {
      name: "specialist",
      systemPromptOverride: "You are a release specialist.",
      instructions: "This should not be appended.",
    }

    expect(composeAgentAwarePrompt(context, profile)).toBe("You are a release specialist.")
  })

  test("builds source researcher from a bounded prompt instead of the full main prompt", () => {
    const sourceResearcher = getBuiltinAgent("source-researcher")

    expect(sourceResearcher).toBeDefined()

    const prompt = composeAgentAwarePrompt(
      context,
      sourceResearcher,
      [
        {
          name: "read",
          guidance: "Generic read guidance that mentions edit anchors.",
          isReadOnly: true,
        },
        {
          name: "shell",
          guidance: "Run local shell commands.",
          isReadOnly: false,
        },
        {
          name: "write",
          guidance: "Create local files.",
          isReadOnly: false,
        },
      ],
      {
        memorySnapshot: "## Memory Snapshot\nDo not leak this into source researcher prompts.",
      },
    )

    expect(prompt).toContain("# Source Researcher Role")
    expect(prompt).toContain("# Source Note Subagent Contract")
    expect(prompt).toContain("read, glob, grep, webfetch, websearch, get_current_datetime")
    expect(prompt).toContain("### Tool: read")
    expect(prompt).toContain("### Tool: glob")
    expect(prompt).toContain("### Tool: grep")
    expect(prompt).toContain("### Tool: webfetch")
    expect(prompt).toContain("### Tool: websearch")
    expect(prompt).toContain("### Tool: get_current_datetime")
    expect(prompt).not.toContain("You are Neo Coworker")
    expect(prompt).not.toContain("direct access to the local filesystem and shell")
    expect(prompt).not.toContain("Creating or editing local files")
    expect(prompt).not.toContain("Prefer the edit tool")
    expect(prompt).not.toContain("### Tool: shell")
    expect(prompt).not.toContain("### Tool: write")
    expect(prompt).not.toContain("### Tool: edit")
    expect(prompt).not.toContain("### Tool: list")
    expect(prompt).not.toContain("shell_cmd")
    expect(prompt).not.toContain("Run local shell commands")
    expect(prompt).not.toContain("Create local files")
    expect(prompt).not.toContain("Memory Snapshot")
  })

  test("keeps main prompt runtime tool guidance and memory snapshot behavior", () => {
    const assembly = buildStaticPromptAssembly({
      toolGuidances: [
        {
          name: "shell",
          guidance: "Use only after read-only inspection is complete.",
          isReadOnly: false,
        },
      ],
      memorySnapshot: "## Memory Snapshot\nPersisted user preference.",
    })

    expect(assembly.hasMemorySnapshot).toBe(true)
    expect(assembly.prompt).toContain("You are Neo Coworker")
    expect(assembly.prompt).toContain("## Memory Snapshot")
    expect(assembly.prompt).toContain("Persisted user preference")
    expect(assembly.prompt).toContain("### Tool: shell")
    expect(assembly.prompt).toContain("Use only after read-only inspection is complete.")
  })
})
