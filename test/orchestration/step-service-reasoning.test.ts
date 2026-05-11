import { describe, expect, test } from "bun:test"
import {
  createOrchestrationStepService,
  type OrchestrationContextWindowPort,
  type OrchestrationModelPort,
  type OrchestrationPartRecord,
  type OrchestrationRunRecord,
  type OrchestrationSessionPort,
  type OrchestrationSkillPort,
  type OrchestrationTimelineMessage,
  type OrchestrationToolPort,
} from "../../src/orchestration"

describe("orchestration step service reasoning persistence", () => {
  test("stores streamed reasoning separately from visible assistant text", async () => {
    const session = createMemorySession()
    const model: OrchestrationModelPort = {
      async *streamTurn() {
        yield {
          type: "reasoning.delta" as const,
          text: "Need to inspect the README",
        }
        yield {
          type: "reasoning.delta" as const,
          text: " before answering.",
        }
        yield {
          type: "text.delta" as const,
          text: "Opening README.md",
        }
      },
    }
    const stepService = createOrchestrationStepService({
      session,
      model,
      contextWindow: createContextWindowStub(),
      skill: createSkillPortStub(),
      now: createMonotonicClock(),
    })

    const result = await stepService.executeStep({
      sessionId: session.sessionId,
      runId: session.runId,
      tools: createToolPortStub(),
      workspaceRoot: "/workspace",
      systemPrompt: "system",
      signal: new AbortController().signal,
      emit() {},
    })

    expect(result).toEqual({ status: "complete" })
    expect(session.listTimeline(session.sessionId)).toEqual([
      {
        runId: session.runId,
        role: "user",
        sequence: 0,
        parts: [{ kind: "text", text: "Inspect README", data: undefined }],
      },
      {
        runId: session.runId,
        role: "assistant",
        sequence: 1,
        parts: [
          {
            id: "part_0",
            kind: "reasoning",
            text: "Need to inspect the README before answering.",
            data: { durationMs: expect.any(Number) },
          },
          {
            id: "part_1",
            kind: "text",
            text: "Opening README.md",
            data: undefined,
          },
        ],
      },
    ])
    const reasoningPart = session.listTimeline(session.sessionId)[1]?.parts[0]
    expect(reasoningPart?.data).toEqual({ durationMs: expect.any(Number) })
    expect((reasoningPart?.data as { durationMs: number }).durationMs).toBeGreaterThan(0)
  })
})

function createMemorySession() {
  const sessionId = "session_reasoning"
  const runId = "run_reasoning"
  let nextMessageId = 0
  let nextPartId = 0
  const timeline: OrchestrationTimelineMessage[] = [
    {
      runId,
      role: "user",
      sequence: 0,
      parts: [{ kind: "text", text: "Inspect README", data: undefined }],
    },
  ]
  const messageIds = new Map<string, OrchestrationTimelineMessage>()
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
        workspaceRoot: "/workspace",
        activeSkills: [],
      }
    },
    getRun(requestedRunId) {
      if (requestedRunId !== runId) {
        throw new Error(`Unknown run ${requestedRunId}`)
      }

      return run
    },
    listTimeline(requestedSessionId) {
      if (requestedSessionId !== sessionId) {
        throw new Error(`Unknown session ${requestedSessionId}`)
      }

      return timeline
    },
    createRun(input) {
      return {
        id: input.id,
        sessionId: input.sessionId,
        createdAt: input.createdAt,
        status: input.status,
        activeSkills: input.activeSkills ?? [],
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        tokenUsageSource: input.tokenUsageSource ?? null,
      }
    },
    createAssistantMessage(input) {
      const id = `assistant_message_${nextMessageId++}`
      const message: OrchestrationTimelineMessage = {
        runId: input.runId,
        role: "assistant",
        sequence: input.sequence,
        parts: [],
      }
      timeline.push(message)
      messageIds.set(id, message)
      return { id }
    },
    createCompactionMessage(input) {
      const id = `compaction_message_${nextMessageId++}`
      const message: OrchestrationTimelineMessage = {
        runId: input.runId,
        role: "compaction",
        sequence: input.sequence,
        parts: [],
      }
      timeline.push(message)
      messageIds.set(id, message)
      return { id }
    },
    createMessagePart(input) {
      const message = messageIds.get(input.messageId)
      if (!message) {
        throw new Error(`Unknown message ${input.messageId}`)
      }

      const part: OrchestrationPartRecord = {
        id: `part_${nextPartId++}`,
        kind: input.kind,
        text: input.text ?? null,
        data: input.data,
      }
      message.parts.push(part)
      partIds.set(part.id, part)
      return part
    },
    updateMessagePart(input) {
      const part = partIds.get(input.partId)
      if (!part) {
        throw new Error(`Unknown part ${input.partId}`)
      }

      if (input.text !== undefined) {
        part.text = input.text
      }
      if (input.data !== undefined) {
        part.data = input.data
      }
      return part
    },
    recordRunTokenUsage(input) {
      run.inputTokens = input.inputTokens
      run.outputTokens = input.outputTokens
      run.tokenUsageSource = input.tokenUsageSource
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

function createContextWindowStub(): OrchestrationContextWindowPort {
  return {
    getContextWindow() {
      return 128_000
    },
  }
}

function createSkillPortStub(): OrchestrationSkillPort {
  return {
    async listCatalog() {
      return []
    },
    async loadSkill() {
      throw new Error("Unexpected skill load")
    },
  }
}

function createToolPortStub(): OrchestrationToolPort {
  return {
    list() {
      return []
    },
    async execute() {
      throw new Error("Unexpected tool execution")
    },
    async executeBatch() {
      throw new Error("Unexpected tool batch execution")
    },
  }
}

function createMonotonicClock(start = 1) {
  let current = start
  return () => {
    const value = current
    current += 1
    return value
  }
}
