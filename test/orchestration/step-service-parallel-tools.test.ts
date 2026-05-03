import { describe, expect, test } from "bun:test"
import {
  createOrchestrationStepService,
  createOrchestrationToolBatchExecutor,
  type OrchestrationContextWindowPort,
  type OrchestrationModelPort,
  type OrchestrationPartRecord,
  type OrchestrationRunRecord,
  type OrchestrationSessionPort,
  type OrchestrationSkillPort,
  type OrchestrationTranscriptMessage,
  type OrchestrationToolPort,
  type RuntimeEvent,
} from "../../src/orchestration"
import { manageResultSize } from "../../src/tool"

function createDelay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe("orchestration step service parallel tool execution", () => {
  test("executes read-only tool calls in parallel and appends results in original order", async () => {
    const session = createMemorySession()
    const progressEvents: RuntimeEvent[] = []
    const model: OrchestrationModelPort = {
      async *streamTurn() {
        yield {
          type: "tool.call" as const,
          callId: "call_read",
          name: "read",
          inputText: '{"path":"alpha.txt"}',
        }
        yield {
          type: "tool.call" as const,
          callId: "call_glob",
          name: "glob",
          inputText: '{"pattern":"**/*.txt"}',
        }
      },
    }
    const tools: OrchestrationToolPort = {
      list() {
        return [
          {
            name: "read",
            description: "Read a file",
            concurrency: "read-only",
          },
          {
            name: "glob",
            description: "Match files",
            concurrency: "read-only",
          },
        ]
      },
      async execute(input) {
        input.onProgress?.(`started:${input.toolName}`)

        if (input.toolName === "read") {
          await createDelay(150)
          return { output: "READ_RESULT" }
        }

        await createDelay(30)
        return { output: "G".repeat(60_000) }
      },
      async executeBatch(input) {
        const results = await createOrchestrationToolBatchExecutor().execute({
          calls: input.calls,
          tools: this,
          availableTools: this.list(),
          workspaceRoot: input.workspaceRoot,
          signal: input.signal,
        })

        return results.map((result) => ({
          ...result,
          ...manageResultSize({
            output: result.output,
            isError: result.isError,
            metadata: result.metadata,
          }),
        }))
      },
    }
    const stepService = createOrchestrationStepService({
      session,
      model,
      contextWindow: createContextWindowStub(),
      skill: createSkillPortStub(),
      now: createMonotonicClock(),
    })
    const startedAt = Date.now()
    const result = await stepService.executeStep({
      sessionId: session.sessionId,
      runId: session.runId,
      tools,
      workspaceRoot: "/workspace",
      systemPrompt: "system",
      signal: new AbortController().signal,
      emit(event) {
        progressEvents.push(event)
      },
    })
    const elapsed = Date.now() - startedAt
    const transcript = session.listTranscript(session.sessionId)
    const assistantMessage = transcript.find((message) => message.role === "assistant")
    const resultParts = assistantMessage?.parts.filter((part) => part.kind === "tool_result") ?? []

    expect(result).toEqual({ status: "repeat" })
    expect(elapsed).toBeLessThan(190)
    expect(assistantMessage?.parts.map((part) => part.kind)).toEqual([
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
    ])
    expect(resultParts.map((part) => (part.data as { callId?: string }).callId)).toEqual([
      "call_read",
      "call_glob",
    ])
    expect(resultParts[0]?.text).toBe("READ_RESULT")
    expect(resultParts[1]?.text).toContain("[Result truncated:")
    expect((resultParts[1]?.data as { metadata?: { truncated?: boolean } })?.metadata?.truncated).toBe(
      true,
    )
    expect(
      progressEvents
        .filter((event): event is Extract<RuntimeEvent, { type: "tool.progress" }> => event.type === "tool.progress")
        .map((event) => event.toolCallId)
        .sort(),
    ).toEqual(["call_glob", "call_read"])
  })

  test("persists thrown tool execution failures as Tool Result Errors before the next model turn", async () => {
    const session = createMemorySession()
    const modelTranscripts: OrchestrationTranscriptMessage[][] = []
    let turn = 0
    const model: OrchestrationModelPort = {
      async *streamTurn(request) {
        modelTranscripts.push(request.transcript)
        turn += 1

        if (turn === 1) {
          yield {
            type: "tool.call" as const,
            callId: "call_boom",
            name: "boom",
            inputText: "{}",
          }
          return
        }

        yield {
          type: "text.delta" as const,
          text: "Recovered after tool failure.",
        }
      },
    }
    const tools: OrchestrationToolPort = {
      list() {
        return [
          {
            name: "boom",
            description: "Throws during execution",
            concurrency: "read-only",
          },
        ]
      },
      async execute() {
        throw new Error("boom exploded")
      },
      async executeBatch(input) {
        return createOrchestrationToolBatchExecutor().execute({
          calls: input.calls,
          tools: this,
          availableTools: this.list(),
          workspaceRoot: input.workspaceRoot,
          signal: input.signal,
        })
      },
    }
    const stepService = createOrchestrationStepService({
      session,
      model,
      contextWindow: createContextWindowStub(),
      skill: createSkillPortStub(),
      now: createMonotonicClock(),
    })

    await expect(executeStep({ stepService, session, tools })).resolves.toEqual({ status: "repeat" })
    await expect(executeStep({ stepService, session, tools })).resolves.toEqual({ status: "complete" })

    const assistantMessage = session
      .listTranscript(session.sessionId)
      .find((message) => message.role === "assistant" && message.sequence === 1)
    const failurePart = assistantMessage?.parts[1]
    const replayedFailurePart = modelTranscripts[1]?.flatMap((message) => message.parts).find(
      (part) =>
        part.kind === "tool_result" &&
        (part.data as { callId?: string } | undefined)?.callId === "call_boom",
    )

    expect(assistantMessage?.parts.map((part) => part.kind)).toEqual(["tool_call", "tool_result"])
    expect(failurePart).toMatchObject({
      kind: "tool_result",
      text: "Tool boom failed: boom exploded",
      data: {
        callId: "call_boom",
        toolName: "boom",
        output: "Tool boom failed: boom exploded",
        isError: true,
        errorCode: "TOOL_EXECUTION_FAILED",
      },
    })
    expect(replayedFailurePart).toMatchObject({
      kind: "tool_result",
      data: {
        callId: "call_boom",
        toolName: "boom",
        isError: true,
        errorCode: "TOOL_EXECUTION_FAILED",
      },
    })
  })
})

function executeStep(input: {
  stepService: ReturnType<typeof createOrchestrationStepService>
  session: ReturnType<typeof createMemorySession>
  tools: OrchestrationToolPort
}) {
  return input.stepService.executeStep({
    sessionId: input.session.sessionId,
    runId: input.session.runId,
    tools: input.tools,
    workspaceRoot: "/workspace",
    systemPrompt: "system",
    signal: new AbortController().signal,
    emit() {},
  })
}

function createContextWindowStub(): OrchestrationContextWindowPort {
  return {
    getContextWindow() {
      return 200_000
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

function createMemorySession() {
  const sessionId = "session_parallel"
  const runId = "run_parallel"
  let nextMessageId = 0
  let nextPartId = 0
  const transcript: OrchestrationTranscriptMessage[] = [
    {
      runId,
      role: "user",
      sequence: 0,
      parts: [{ kind: "text", text: "Run both tools", data: undefined }],
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
    listTranscript(requestedSessionId) {
      if (requestedSessionId !== sessionId) {
        throw new Error(`Unknown session ${requestedSessionId}`)
      }

      return transcript
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
      const message: OrchestrationTranscriptMessage = {
        runId: input.runId,
        role: "assistant",
        sequence: input.sequence,
        parts: [],
      }
      transcript.push(message)
      messageIds.set(id, message)
      return { id }
    },
    createSyntheticMessage(input) {
      const id = `synthetic_message_${nextMessageId++}`
      const message: OrchestrationTranscriptMessage = {
        runId: input.runId,
        role: "synthetic",
        sequence: input.sequence,
        parts: [],
      }
      transcript.push(message)
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

function createMonotonicClock(start = 1) {
  let current = start
  return () => {
    const value = current
    current += 1
    return value
  }
}
