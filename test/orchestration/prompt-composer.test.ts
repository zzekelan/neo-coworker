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
  defaultSections,
  getDynamicPrompt,
  getStaticPrompt,
} from "../../src/orchestration/application/prompt-composer"
import { createOrchestrationRuntimeApi } from "../../src/orchestration/infrastructure/runtime/create-runtime"
import { createInMemoryActiveRunRegistry } from "../../src/orchestration/infrastructure/runtime/active-run-registry"

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

  test("builds a static prompt with the five designed sections and key constraints", () => {
    const systemPrompt = getStaticPrompt()

    expect(systemPrompt).toContain("You are Neo Coworker, an autonomous software engineering agent.")
    expect(systemPrompt).toContain("## Executing Tasks")
    expect(systemPrompt).toContain("Make the minimal change needed")
    expect(systemPrompt).toContain("Do not add logging, telemetry, or error tracking unless asked.")
    expect(systemPrompt).toContain("## Operating with Care")
    expect(systemPrompt).toContain("Never skip pre-commit hooks or bypass safety checks.")
    expect(systemPrompt).toContain("## Using Your Tools")
    expect(systemPrompt).toContain("{PER_TOOL_GUIDANCE_PLACEHOLDER}")
    expect(systemPrompt).toContain("## Communication Style")
    expect(systemPrompt).toContain('Never start responses with "I"')
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

  test("composes the full prompt as static plus dynamic sections", () => {
    const staticPrompt = getStaticPrompt()
    const dynamicPrompt = getDynamicPrompt({
      environment: {
        workingDirectory: "/workspace/project",
        platform: "linux",
        date: "2026-04-07",
      },
    })
    const fullPrompt = composeFullPrompt({
      environment: {
        workingDirectory: "/workspace/project",
        platform: "linux",
        date: "2026-04-07",
      },
    })

    expect(fullPrompt).toBe([staticPrompt, dynamicPrompt].join("\n\n"))
  })

  test("runtime uses the composed default prompt and preserves skill reminders", async () => {
    const observedRequests: OrchestrationModelTurnRequest[] = []
    const session = createSessionPortStub()
    const model: OrchestrationModelPort = {
      projectTurn(request) {
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
    expect(finalRequest?.systemPrompt).toContain("You are Neo Coworker, an autonomous software engineering agent.")
    expect(finalRequest?.systemPrompt).toContain("## Dynamic Context")
    expect(finalRequest?.systemPrompt).toContain("/workspace/project")
    expect(finalRequest?.systemPrompt).toContain("reviewer")
    expect(finalRequest?.activeSkills).toEqual([
      {
        name: "reviewer",
        instructions: "Review every diff before accepting it.",
      },
    ])
    expect(finalRequest?.systemReminders?.join("\n\n")).toContain("Active skill instructions:")
    expect(finalRequest?.systemReminders?.join("\n\n")).toContain("Skill catalog:")
  })
})

const allowAllPermissionPolicy: OrchestrationPermissionPolicy = {
  write: "allow",
  edit: "allow",
  shell: "allow",
  webfetch: "allow",
  websearch: "allow",
  codesearch: "allow",
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

function createToolPortFactoryStub(): OrchestrationToolPortFactory {
  return {
    create() {
      return {
        list() {
          return []
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
