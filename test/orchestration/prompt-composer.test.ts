import { describe, expect, test } from "bun:test"
import { countTokens } from "gpt-tokenizer/model/gpt-4o"
import type {
  OrchestrationModelPort,
  OrchestrationModelTurnRequest,
} from "../../src/orchestration/application/ports/model"
import type { OrchestrationPermissionPort } from "../../src/orchestration/application/ports/permission"
import type {
  OrchestrationRunRecord,
  OrchestrationSessionPort,
} from "../../src/orchestration/application/ports/session"
import type { OrchestrationSkillPort } from "../../src/orchestration/application/ports/skill"
import type { OrchestrationToolPortFactory } from "../../src/orchestration/application/ports/tool"
import type { OrchestrationPermissionPolicy } from "../../src/orchestration/application/permission"
import {
  composeFullPrompt,
  composeSystemPrompt,
  buildLateContextMessage,
  defaultSections,
  getDynamicPrompt,
  getStaticPrompt,
  type ToolGuidanceEntry,
} from "../../src/orchestration/application/prompt-composer"
import { createOrchestrationRuntimeApi } from "../../src/orchestration/infrastructure/runtime/create-runtime"
import { createInMemoryActiveRunRegistry } from "../../src/orchestration/infrastructure/runtime/active-run-registry"

type GuidedOrchestrationToolStub = {
  name: string
  description: string
  concurrency?: "read-only" | "mutating"
  isConcurrencySafe?: (input: unknown) => boolean
  usageGuidance?: string
  isCompressible?: boolean
}

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
    expect(defaultSections).toHaveLength(5)
  })

  test("marks all default sections as static", () => {
    expect(defaultSections.every((section) => section.isStatic)).toBe(true)
  })

  test("builds a static prompt with the five designed sections and key constraints", () => {
    const systemPrompt = getStaticPrompt()

    expect(systemPrompt).toContain("You are Neo Coworker, a versatile personal work assistant")
    expect(systemPrompt).toContain("# Executing Tasks")
    expect(systemPrompt).toContain("Understand before acting")
    expect(systemPrompt).toContain("Report outcomes faithfully")
    expect(systemPrompt).toContain("# Operating with Care")
    expect(systemPrompt).toContain("Measure twice, cut once")
    expect(systemPrompt).toContain("# Using Your Tools")
    expect(systemPrompt).toContain("# Communication Style")
    expect(systemPrompt).toContain("Match your response depth to the task at hand")
  })

  test("keeps the static prompt token count identical across ten calls", () => {
    const tokenCounts = Array.from({ length: 10 }, () => countTokens(getStaticPrompt()))

    expect(new Set(tokenCounts).size).toBe(1)
  })

  test("keeps the composed prompt under the token budget", () => {
    const prompt = composeFullPrompt({
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
    })

    expect(countTokens(prompt)).toBeLessThan(2000)
  })

  test("builds a dynamic prompt that changes with context", () => {
    const firstPrompt = getDynamicPrompt({
      activeSkillNames: ["reviewer"],
      environment: {
        workingDirectory: "/workspace/one",
        isGitRepository: true,
        platform: "linux",
        shell: "bash",
        date: "2026-04-07",
      },
      sessionGuidance: ["Stay inside the current repository."],
      systemReminders: ["<system-reminder>Skill catalog updated</system-reminder>"],
    })
    const secondPrompt = getDynamicPrompt({
      activeSkillNames: ["release-manager"],
      environment: {
        workingDirectory: "/workspace/two",
        isGitRepository: false,
        platform: "darwin",
        shell: "zsh",
        date: "2026-04-08",
      },
      sessionGuidance: ["Avoid touching deployment infrastructure."],
      systemReminders: ["<system-reminder>Recovery note</system-reminder>"],
    })

    expect(firstPrompt).toContain("## Dynamic Context")
    expect(firstPrompt).toContain("/workspace/one")
    expect(firstPrompt).toContain("reviewer")
    expect(firstPrompt).toContain("Skill catalog updated")
    expect(firstPrompt).not.toBe(secondPrompt)
    expect(secondPrompt).toContain("/workspace/two")
    expect(secondPrompt).toContain("release-manager")
    expect(secondPrompt).toContain("Recovery note")
  })

  test("composeFullPrompt now returns the static prompt only", () => {
    const staticPrompt = getStaticPrompt()
    const fullPrompt = composeFullPrompt({
      environment: {
        workingDirectory: "/workspace/project",
        platform: "linux",
        date: "2026-04-07",
      },
    })

    expect(fullPrompt).toBe(staticPrompt)
  })

  test("static prompt does not contain dynamic context values", () => {
    const prompt = getStaticPrompt()

    expect(prompt).not.toContain("## Dynamic Context")
    expect(prompt).not.toContain("/workspace/project")
    expect(prompt).not.toContain("2026-04-07")
    expect(prompt).not.toContain("reviewer")
  })

  test("buildLateContextMessage formats dynamic context for late injection", () => {
    const message = buildLateContextMessage({
      activeSkillNames: ["reviewer", "planner"],
      environment: {
        workingDirectory: "/workspace/project",
        isGitRepository: true,
        platform: "linux",
        shell: "bash",
        date: "2026-04-07",
      },
      sessionGuidance: ["Stay within the current workspace root."],
      systemReminders: ["<system-reminder>Skill catalog updated</system-reminder>"],
    })

    expect(message).toBe(
      [
        "<system-reminder>",
        "- Active skills: reviewer, planner",
        "- Session-specific guidance:",
        "  - Stay within the current workspace root.",
        "- Environment:",
        "- Working directory: /workspace/project",
        "- Is directory a git repo: yes",
        "- Platform: linux",
        "- Shell: bash",
        "- Date: 2026-04-07",
        "- Active reminders:",
        "<system-reminder>Skill catalog updated</system-reminder>",
        "</system-reminder>",
      ].join("\n"),
    )
  })

  test("buildLateContextMessage includes recommended skills when provided", () => {
    const message = buildLateContextMessage({
      activeSkillNames: ["reviewer"],
      recommendedSkills: [" planner ", "researcher"],
      environment: {
        workingDirectory: "/workspace/project",
        platform: "linux",
        date: "2026-04-18",
      },
    })

    expect(message).toBe(
      [
        "<system-reminder>",
        "- Active skills: reviewer",
        "- Recommended skills for current agent:",
        "planner, researcher",
        "Use the skill tool to activate any of these when needed.",
        "- Environment:",
        "- Working directory: /workspace/project",
        "- Platform: linux",
        "- Date: 2026-04-18",
        "</system-reminder>",
      ].join("\n"),
    )
  })

  test("buildLateContextMessage omits recommended skills when absent or empty", () => {
    const absentMessage = buildLateContextMessage({
      activeSkillNames: ["reviewer"],
      environment: {
        workingDirectory: "/workspace/project",
        platform: "linux",
        date: "2026-04-18",
      },
    })
    const emptyMessage = buildLateContextMessage({
      activeSkillNames: ["reviewer"],
      recommendedSkills: [" ", ""],
      environment: {
        workingDirectory: "/workspace/project",
        platform: "linux",
        date: "2026-04-18",
      },
    })

    expect(absentMessage).not.toContain("- Recommended skills for current agent:")
    expect(emptyMessage).not.toContain("- Recommended skills for current agent:")
  })

  test("static prompt excludes the unrelated websearch news URL contamination", () => {
    const prompt = getStaticPrompt()

    expect(prompt).not.toContain("especially with news")
  })

  describe("per-tool guidance injection", () => {
    const readOnlyGuidance: ToolGuidanceEntry = {
      name: "read",
      guidance: "Use offset and limit to navigate large files.",
      isReadOnly: true,
    }
    const mutatingGuidance: ToolGuidanceEntry = {
      name: "shell",
      guidance: "Prefer read/write/edit tools over shell for file operations.",
      isReadOnly: false,
    }
    const anotherReadOnly: ToolGuidanceEntry = {
      name: "grep",
      guidance: "Prefer files_with_matches for broad discovery.",
      isReadOnly: true,
    }

    test("replaces placeholder with formatted tool guidance", () => {
      const prompt = getStaticPrompt([readOnlyGuidance])

      expect(prompt).not.toContain("{PER_TOOL_GUIDANCE_PLACEHOLDER}")
      expect(prompt).toContain("### Tool: read")
      expect(prompt).toContain("Use offset and limit to navigate large files.")
    })

    test("skips tools without guidance (empty list produces no section)", () => {
      const prompt = getStaticPrompt([])

      expect(prompt).not.toContain("{PER_TOOL_GUIDANCE_PLACEHOLDER}")
      expect(prompt).not.toContain("### Tool:")
    })

    test("orders read-only tools before mutating tools", () => {
      const prompt = getStaticPrompt([mutatingGuidance, readOnlyGuidance])

      const readIndex = prompt.indexOf("### Tool: read")
      const shellIndex = prompt.indexOf("### Tool: shell")
      expect(readIndex).toBeLessThan(shellIndex)
    })

    test("formats each tool as its own subsection", () => {
      const prompt = getStaticPrompt([readOnlyGuidance, mutatingGuidance])

      expect(prompt).toContain("### Tool: read\nUse offset and limit to navigate large files.")
      expect(prompt).toContain(
        "### Tool: shell\nPrefer read/write/edit tools over shell for file operations.",
      )
    })

    test("preserves read-only tools order among themselves and mutating tools order among themselves", () => {
      const prompt = getStaticPrompt([anotherReadOnly, readOnlyGuidance, mutatingGuidance])

      const grepIndex = prompt.indexOf("### Tool: grep")
      const readIndex = prompt.indexOf("### Tool: read")
      const shellIndex = prompt.indexOf("### Tool: shell")
      expect(grepIndex).toBeLessThan(shellIndex)
      expect(readIndex).toBeLessThan(shellIndex)
    })

    test("composeFullPrompt also accepts and injects tool guidances", () => {
      const prompt = composeFullPrompt(
        {
          environment: {
            workingDirectory: "/workspace",
            platform: "linux",
            date: "2026-04-07",
          },
        },
        [readOnlyGuidance],
      )

      expect(prompt).not.toContain("{PER_TOOL_GUIDANCE_PLACEHOLDER}")
      expect(prompt).toContain("### Tool: read")
    })

    test("without guidances argument, placeholder is removed and no tool sections appear", () => {
      const prompt = getStaticPrompt()

      expect(prompt).not.toContain("{PER_TOOL_GUIDANCE_PLACEHOLDER}")
      expect(prompt).not.toContain("### Tool:")
    })

    test("tool guidance section stays within 40% of total static prompt token budget", () => {
      const guidances: ToolGuidanceEntry[] = [
        { name: "read", guidance: "Use offset and limit to navigate large files.", isReadOnly: true },
        {
          name: "glob",
          guidance: "Use glob when you need to discover files by name pattern.",
          isReadOnly: true,
        },
        {
          name: "grep",
          guidance: "Prefer files_with_matches for broad discovery.",
          isReadOnly: true,
        },
        {
          name: "websearch",
          guidance: "Prefer websearch over webfetch when you do not know the URL.",
          isReadOnly: true,
        },
        {
          name: "codesearch",
          guidance: "Use codesearch for external code examples when local grep finds nothing.",
          isReadOnly: true,
        },
        {
          name: "shell",
          guidance: "Prefer dedicated file tools over shell for file operations.",
          isReadOnly: false,
        },
        { name: "write", guidance: "Use write only for new files or full rewrites.", isReadOnly: false },
        { name: "edit", guidance: "Prefer edit for targeted changes in existing files.", isReadOnly: false },
      ]
      const fullPrompt = getStaticPrompt(guidances)
      const totalTokens = countTokens(fullPrompt)

      // Extract just the tool guidance section
      const toolSectionStart = fullPrompt.indexOf("### Tool:")
      const toolSectionEnd = fullPrompt.lastIndexOf("\n\n## ")
      const toolSection =
        toolSectionStart !== -1
          ? toolSectionEnd !== -1
            ? fullPrompt.slice(toolSectionStart, toolSectionEnd)
            : fullPrompt.slice(toolSectionStart)
          : ""

      const toolSectionTokens = toolSection ? countTokens(toolSection) : 0
      expect(toolSectionTokens).toBeLessThanOrEqual(totalTokens * 0.4)
    })
  })

  test("runtime uses the composed default prompt and preserves skill reminders", async () => {
    const observedRequests: OrchestrationModelTurnRequest[] = []
    const session = createSessionPortStub()
    const model: OrchestrationModelPort = {
      projectTurn() {
        return { inputTokens: 128 }
      },
      async *streamTurn(request) {
        observedRequests.push(request)
        yield {
          type: "usage",
          inputTokens: 128,
          outputTokens: 0,
          source: "estimated",
        } as const
      },
    }
    const runtime = createOrchestrationRuntimeApi({
      model,
      session,
      skill: createSkillPortStub(),
      permission: createPermissionPortStub(),
      tools: createToolPortFactoryStub(),
      activeRuns: createInMemoryActiveRunRegistry(),
      permissionPolicy: allowAllPermissionPolicy,
      now: () => Date.parse("2026-04-07T00:00:00.000Z"),
    })

    const handle = await runtime.run({
      sessionId: "session-1",
      runId: "run-1",
    })

    for await (const _event of handle.events) {
    }

    const finalRequest = observedRequests.at(-1)
    expect(finalRequest).toBeDefined()
    expect(finalRequest?.systemPrompt).toContain("You are Neo Coworker, a versatile personal work assistant")
    expect(finalRequest?.systemPrompt).not.toContain("## Dynamic Context")
    expect(finalRequest?.lateContextMessage).toContain("- Working directory: /workspace/project")
    expect(finalRequest?.lateContextMessage).toContain("- Active skills: reviewer")
    expect(finalRequest?.activeSkills).toEqual([
      {
        name: "reviewer",
        instructions: "Review every diff before accepting it.",
      },
    ])
    const reminderPayload = finalRequest?.systemReminders?.join("\n\n") ?? ""
    expect(reminderPayload).toContain("Active skill instructions:")
    expect(reminderPayload).toContain("Skill catalog:")
  })

  test("runtime default prompt injects tool guidance from orchestration tool metadata", async () => {
    const observedRequests: OrchestrationModelTurnRequest[] = []
    const session = createSessionPortStub()
    const model: OrchestrationModelPort = {
      projectTurn() {
        return { inputTokens: 128 }
      },
      async *streamTurn(request) {
        observedRequests.push(request)
        yield {
          type: "usage",
          inputTokens: 128,
          outputTokens: 0,
          source: "estimated",
        } as const
      },
    }

    const runtime = createOrchestrationRuntimeApi({
      model,
      session,
      skill: createSkillPortStub(),
      permission: createPermissionPortStub(),
      tools: createToolPortFactoryStub([
        {
          name: "read",
          description: "Read a file",
          concurrency: "read-only",
          usageGuidance: "Use offset and limit to inspect large files.",
          isCompressible: true,
        },
        {
          name: "shell",
          description: "Execute shell commands",
          concurrency: "mutating",
          usageGuidance: "Use only after read-only inspection is complete.",
          isCompressible: false,
        },
      ]),
      activeRuns: createInMemoryActiveRunRegistry(),
      permissionPolicy: allowAllPermissionPolicy,
      now: () => Date.parse("2026-04-07T00:00:00.000Z"),
    })

    const handle = await runtime.run({
      sessionId: "session-1",
      runId: "run-1",
    })

    for await (const _event of handle.events) {
    }

    const finalRequest = observedRequests.at(-1)
    expect(finalRequest).toBeDefined()
    expect(finalRequest?.systemPrompt).toContain("### Tool: read")
    expect(finalRequest?.systemPrompt).toContain("Use offset and limit to inspect large files.")
    expect(finalRequest?.systemPrompt).toContain("### Tool: shell")
    expect(finalRequest?.systemPrompt).toContain("Use only after read-only inspection is complete.")

    const readIndex = finalRequest?.systemPrompt.indexOf("### Tool: read") ?? -1
    const shellIndex = finalRequest?.systemPrompt.indexOf("### Tool: shell") ?? -1
    expect(readIndex).toBeGreaterThan(-1)
    expect(shellIndex).toBeGreaterThan(-1)
    expect(readIndex).toBeLessThan(shellIndex)
  })
})

const allowAllPermissionPolicy: OrchestrationPermissionPolicy = {
  write: "allow",
  edit: "allow",
  shell: "allow",
  webfetch: "allow",
  websearch: "allow",
  codesearch: "allow",
  plan_exit: "allow",
}

function createSessionPortStub(): OrchestrationSessionPort {
  const sessionRecord = {
    id: "session-1",
    workspaceRoot: "/workspace/project",
    activeSkills: ["reviewer"],
  }
  let runRecord: OrchestrationRunRecord = {
    id: "run-1",
    sessionId: sessionRecord.id,
    createdAt: 0,
    status: "queued",
    activeSkills: [],
    inputTokens: 0,
    outputTokens: 0,
    tokenUsageSource: null,
  }

  return {
    storageIdentity: "memory",
    getSession(sessionId) {
      expect(sessionId).toBe(sessionRecord.id)
      return sessionRecord
    },
    getRun(runId) {
      expect(runId).toBe(runRecord.id)
      return runRecord
    },
    listTranscript() {
      return []
    },
    createRun() {
      return runRecord
    },
    createAssistantMessage() {
      return { id: "message-1" }
    },
    createSyntheticMessage() {
      return { id: "synthetic-message-1" }
    },
    createMessagePart(input) {
      return {
        id: `${input.messageId}:${input.sequence}`,
        kind: input.kind,
        text: input.text ?? null,
        data: input.data,
      }
    },
    updateMessagePart(input) {
      return {
        id: input.partId,
        kind: "updated",
        text: input.text ?? null,
        data: input.data,
      }
    },
    recordRunTokenUsage(input) {
      runRecord = {
        ...runRecord,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        tokenUsageSource: input.tokenUsageSource,
      }
      return runRecord
    },
    transitionRunToRunning() {
      runRecord = {
        ...runRecord,
        status: "running",
      }
      return runRecord
    },
    completeRun() {
      runRecord = {
        ...runRecord,
        status: "completed",
      }
      return runRecord
    },
    failRun() {
      runRecord = {
        ...runRecord,
        status: "failed",
      }
      return runRecord
    },
    cancelRun() {
      runRecord = {
        ...runRecord,
        status: "cancelled",
      }
      return runRecord
    },
  }
}

function createSkillPortStub(): OrchestrationSkillPort {
  return {
    async listCatalog() {
      return [
        {
          name: "reviewer",
          description: "Review changes before shipping.",
          path: ".agents/skills/reviewer/SKILL.md",
        },
      ]
    },
    async loadSkill() {
      return {
        name: "reviewer",
        instructions: "Review every diff before accepting it.",
        path: ".agents/skills/reviewer/SKILL.md",
      }
    },
  }
}

function createPermissionPortStub(): OrchestrationPermissionPort {
  return {
    createCoordinator() {
      return {
        async request() {
          return {
            requestId: "permission-1",
            decision: "allow",
          }
        },
        resolve() {},
        cancelAll() {},
      }
    },
    getPermissionRequest() {
      throw new Error("Not implemented in test")
    },
    requestPermission() {
      throw new Error("Not implemented in test")
    },
    respondPermission() {
      throw new Error("Not implemented in test")
    },
    cancelPendingRequestsByRun() {
      return []
    },
  }
}

function createToolPortFactoryStub(tools: GuidedOrchestrationToolStub[] = []): OrchestrationToolPortFactory {
  return {
    create() {
      return {
        list() {
          return tools
        },
        async execute() {
          throw new Error("No tools expected in this test")
        },
        async executeBatch() {
          return []
        },
      }
    },
  }
}
