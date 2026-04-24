import { describe, expect, test } from "bun:test"
import {
  SYSTEM_REMINDER_NOTICE,
  createFakeProvider,
  createModelProvider,
  type ProviderTurnRequest,
} from "../../src/model"
import {
  createOrchestrationStepService,
  type OrchestrationContextWindowPort,
  type OrchestrationPartRecord,
  type OrchestrationRunRecord,
  type OrchestrationSessionPort,
  type OrchestrationSkillPort,
  type OrchestrationTranscriptMessage,
  type OrchestrationToolPort,
} from "../../src/orchestration"
import { buildLateContextMessage } from "../../src/orchestration/application/prompt-composer"

describe("agent instruction late-context injection", () => {
  test("includes agent instructions in the late-context system reminder when provided", () => {
    const message = buildLateContextMessage({
      activeSkillNames: ["reviewer"],
      agentInstructions: "Plan before acting.",
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
        "- Agent instructions:",
        "Plan before acting.",
        "- Environment:",
        "- Working directory: /workspace/project",
        "- Platform: linux",
        "- Date: 2026-04-18",
        "</system-reminder>",
      ].join("\n"),
    )
  })

  test("keeps late-context output unchanged when no agent instructions are present", () => {
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

    expect(message).not.toContain("- Agent instructions:")
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

  test("includes recommended skills in late-context only when provided", () => {
    const message = buildLateContextMessage({
      activeSkillNames: ["reviewer"],
      recommendedSkills: ["planner", "researcher"],
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

  test("does not inject recommended skills when the current agent profile has none", async () => {
    const requests: ProviderTurnRequest[] = []
    const model = createModelProvider({
      runtime: createFakeProvider({
        onRequest(request) {
          requests.push(request)
        },
        events: [
          {
            type: "usage",
            inputTokens: 64,
            outputTokens: 0,
            source: "estimated",
          },
        ],
      }),
    })
    const session = createMemorySession({
      currentAgent: "plan",
      activeSkills: ["reviewer"],
      userText: "Inspect README.md",
    })
    const stepService = createOrchestrationStepService({
      session,
      model,
      agentProfiles: {
        async getResolvedProfile() {
          return {
            instructions: "Plan mode active.",
          }
        },
      },
      contextWindow: {
        getContextWindow() {
          return 128_000
        },
      } satisfies OrchestrationContextWindowPort,
      skill: createSkillPortStub(),
      now: createMonotonicClock(),
    })

    const outcome = await stepService.executeStep({
      sessionId: session.sessionId,
      runId: session.runId,
      tools: createToolPortStub(),
      workspaceRoot: "/workspace/project",
      systemPrompt: "static system prompt",
      signal: new AbortController().signal,
      emit() {},
    })

    expect(outcome).toEqual({ status: "complete" })
    expect(requests).toHaveLength(1)

    const request = requests[0]!
    const joinedTexts = readMessageTexts(request).join("\n\n")

    expect(request.system).not.toContain("- Recommended skills for current agent:")
    expect(joinedTexts).not.toContain("- Recommended skills for current agent:")
    expect(joinedTexts).toContain("- Agent instructions:")
    expect(joinedTexts).toContain("Plan mode active.")
  })

  test("injects current agent instructions and recommended skills only into late-context", async () => {
    const requests: ProviderTurnRequest[] = []
    const loadedSkillNames: string[] = []
    const model = createModelProvider({
      runtime: createFakeProvider({
        onRequest(request) {
          requests.push(request)
        },
        events: [
          {
            type: "usage",
            inputTokens: 64,
            outputTokens: 0,
            source: "estimated",
          },
        ],
      }),
    })
    const session = createMemorySession({
      currentAgent: "plan",
      activeSkills: ["reviewer"],
      userText: "Inspect README.md",
    })
    const stepService = createOrchestrationStepService({
      session,
      model,
      agentProfiles: {
        async getResolvedProfile(input) {
          expect(input.workspaceRoot).toBe("/workspace/project")
          expect(input.name).toBe("plan")
          return {
            instructions: "Plan mode active.",
            skills: ["planner", "researcher"],
          }
        },
      },
      contextWindow: {
        getContextWindow() {
          return 128_000
        },
      } satisfies OrchestrationContextWindowPort,
      skill: createSkillPortStub(loadedSkillNames),
      now: createMonotonicClock(),
    })

    const outcome = await stepService.executeStep({
      sessionId: session.sessionId,
      runId: session.runId,
      tools: createToolPortStub(),
      workspaceRoot: "/workspace/project",
      systemPrompt: "static system prompt",
      signal: new AbortController().signal,
      emit() {},
    })

    expect(outcome).toEqual({ status: "complete" })
    expect(requests).toHaveLength(1)

    const request = requests[0]!
    const messageTexts = readMessageTexts(request)
    const lateContextText = messageTexts.find((text) => text.includes("- Agent instructions:"))
    const nonLateContextTexts = messageTexts.filter((text) => !text.includes("- Agent instructions:"))

    expect(request.system).toBe(["static system prompt", SYSTEM_REMINDER_NOTICE].join("\n\n"))
    expect(request.system).not.toContain("Plan mode active.")
    expect(request.system).not.toContain("planner")
    expect(lateContextText).toContain("<system-reminder>")
    expect(lateContextText).toContain("- Agent instructions:")
    expect(lateContextText).toContain("Plan mode active.")
    expect(lateContextText).toContain("- Recommended skills for current agent:")
    expect(lateContextText).toContain("planner, researcher")
    expect(lateContextText).toContain("Use the skill tool to activate any of these when needed.")
    expect(lateContextText).toContain("- Active reminders:")
    expect(nonLateContextTexts.join("\n\n")).toContain("Skill catalog:")
    expect(nonLateContextTexts.join("\n\n")).toContain("Active skill instructions:")
    expect(nonLateContextTexts.join("\n\n")).not.toContain("Plan mode active.")
    expect(nonLateContextTexts.join("\n\n")).not.toContain("- Recommended skills for current agent:")
    expect(nonLateContextTexts.join("\n\n")).not.toContain("planner")
    expect(messageTexts.join("\n\n").match(/Plan mode active\./g)?.length ?? 0).toBe(1)
    expect(messageTexts.join("\n\n").match(/planner/g)?.length ?? 0).toBe(1)
    expect(session.getSession(session.sessionId).activeSkills).toEqual(["reviewer"])
    expect(loadedSkillNames).toEqual(["reviewer"])
  })

  test("passes resolved agent temperature through to the provider-facing request", async () => {
    const requests: ProviderTurnRequest[] = []
    const model = createModelProvider({
      runtime: createFakeProvider({
        onRequest(request) {
          requests.push(request)
        },
        events: [
          {
            type: "usage",
            inputTokens: 64,
            outputTokens: 0,
            source: "estimated",
          },
        ],
      }),
    })
    const session = createMemorySession({
      currentAgent: "plan",
      activeSkills: ["reviewer"],
      userText: "Inspect README.md",
    })
    const stepService = createOrchestrationStepService({
      session,
      model,
      agentProfiles: {
        async getResolvedProfile() {
          return {
            instructions: "Plan mode active.",
            temperature: 0,
          }
        },
      },
      contextWindow: {
        getContextWindow() {
          return 128_000
        },
      } satisfies OrchestrationContextWindowPort,
      skill: createSkillPortStub(),
      now: createMonotonicClock(),
    })

    const outcome = await stepService.executeStep({
      sessionId: session.sessionId,
      runId: session.runId,
      tools: createToolPortStub(),
      workspaceRoot: "/workspace/project",
      systemPrompt: "static system prompt",
      signal: new AbortController().signal,
      emit() {},
    })

    expect(outcome).toEqual({ status: "complete" })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.temperature).toBe(0)
  })
})

function createMemorySession(input: {
  currentAgent?: string
  activeSkills?: string[]
  userText: string
}) {
  const sessionId = "session_agent_instructions"
  const runId = "run_agent_instructions"
  let nextMessageId = 0
  let nextPartId = 0
  const transcript: OrchestrationTranscriptMessage[] = [
    {
      runId,
      role: "user",
      sequence: 0,
      parts: [{ kind: "text", text: input.userText, data: undefined }],
    },
  ]
  const messageIds = new Map<string, OrchestrationTranscriptMessage>()
  const partIds = new Map<string, OrchestrationPartRecord>()
  const run: OrchestrationRunRecord = {
    id: runId,
    sessionId,
    createdAt: 1,
    status: "running",
    activeSkills: [],
    inputTokens: 0,
    outputTokens: 0,
    tokenUsageSource: null,
  }

  const session: OrchestrationSessionPort & { sessionId: string; runId: string } = {
    sessionId,
    runId,
    storageIdentity: "memory",
    getSession(requestedSessionId) {
      if (requestedSessionId !== sessionId) {
        throw new Error(`Unknown session ${requestedSessionId}`)
      }

      return {
        id: sessionId,
        workspaceRoot: "/workspace/project",
        currentAgent: input.currentAgent,
        activeSkills: input.activeSkills ?? [],
      }
    },
    getRun(requestedRunId) {
      if (requestedRunId !== runId) {
        throw new Error(`Unknown run ${requestedRunId}`)
      }

      return run
    },
    listTranscript(requestedSessionId) {
      if (requestedSessionId !== sessionId) {
        throw new Error(`Unknown session ${requestedSessionId}`)
      }

      return transcript
    },
    createRun(runInput) {
      return {
        id: runInput.id,
        sessionId: runInput.sessionId,
        createdAt: runInput.createdAt,
        status: runInput.status,
        activeSkills: runInput.activeSkills ?? [],
        inputTokens: runInput.inputTokens ?? 0,
        outputTokens: runInput.outputTokens ?? 0,
        tokenUsageSource: runInput.tokenUsageSource ?? null,
      }
    },
    createAssistantMessage(messageInput) {
      const id = `assistant_message_${nextMessageId++}`
      const message: OrchestrationTranscriptMessage = {
        runId: messageInput.runId,
        role: "assistant",
        sequence: messageInput.sequence,
        parts: [],
      }
      transcript.push(message)
      messageIds.set(id, message)
      return { id }
    },
    createSyntheticMessage(messageInput) {
      const id = `synthetic_message_${nextMessageId++}`
      const message: OrchestrationTranscriptMessage = {
        runId: messageInput.runId,
        role: "synthetic",
        sequence: messageInput.sequence,
        parts: [],
      }
      transcript.push(message)
      messageIds.set(id, message)
      return { id }
    },
    createMessagePart(partInput) {
      const message = messageIds.get(partInput.messageId)
      if (!message) {
        throw new Error(`Unknown message ${partInput.messageId}`)
      }

      const part: OrchestrationPartRecord = {
        id: `part_${nextPartId++}`,
        kind: partInput.kind,
        text: partInput.text ?? null,
        data: partInput.data,
      }
      message.parts.push(part)
      partIds.set(part.id, part)
      return part
    },
    updateMessagePart(partInput) {
      const part = partIds.get(partInput.partId)
      if (!part) {
        throw new Error(`Unknown part ${partInput.partId}`)
      }

      part.text = partInput.text ?? part.text
      part.data = partInput.data ?? part.data
      return part
    },
    recordRunTokenUsage(runInput) {
      run.inputTokens = runInput.inputTokens
      run.outputTokens = runInput.outputTokens
      run.tokenUsageSource = runInput.tokenUsageSource
      return run
    },
    transitionRunToRunning() {
      run.status = "running"
      return run
    },
    completeRun() {
      run.status = "completed"
      return run
    },
    failRun() {
      run.status = "failed"
      return run
    },
    cancelRun() {
      run.status = "cancelled"
      return run
    },
  }

  return session
}

function createSkillPortStub(loadedSkillNames: string[] = []): OrchestrationSkillPort {
  return {
    async listCatalog() {
      return [
        {
          name: "reviewer",
          description: "Review code changes carefully",
          path: ".ncoworker/skills/reviewer/SKILL.md",
        },
      ]
    },
    async loadSkill(input) {
      loadedSkillNames.push(input.name)
      return {
        name: input.name,
        instructions: "Focus on bugs first.",
        path: `.ncoworker/skills/${input.name}/SKILL.md`,
      }
    },
  }
}

function createToolPortStub(): OrchestrationToolPort {
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
}

function readMessageTexts(request: ProviderTurnRequest) {
  return request.messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    ),
  )
}

function createMonotonicClock(start = 1) {
  let current = start
  return () => {
    const value = current
    current += 1
    return value
  }
}
