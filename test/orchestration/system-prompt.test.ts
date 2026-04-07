import { describe, expect, test } from "bun:test"
import type { AgentProfile } from "../../src/agent/public/index.ts"
import {
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
})
