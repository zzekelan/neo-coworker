import { describe, expect, test } from "bun:test"
import {
  MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
  buildModelTurnProjection,
  type ModelProjectionInput,
  type ModelTimelineMessage,
} from "../../src/model"
import {
  createOrchestrationStepService,
  type OrchestrationContextWindowPort,
  type OrchestrationModelPort,
  type OrchestrationModelTurnRequest,
  type OrchestrationPartRecord,
  type OrchestrationRunRecord,
  type OrchestrationSessionPort,
  type OrchestrationSkillPort,
  type OrchestrationTimelineMessage,
  type OrchestrationToolPort,
} from "../../src/orchestration"
import {
  createEditTool,
  createReadTool,
  type ToolDefinition,
} from "../../src/tool"

function deriveCompressibleToolNames(tools: readonly ToolDefinition[]) {
  return new Set(tools.filter((tool) => tool.isCompressible).map((tool) => tool.name))
}

function makeTimeline(toolName: string, count: number): ModelTimelineMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message_${toolName}_${index}`,
    sessionId: "session_1",
    runId: "run_1",
    role: "assistant" as const,
    sequence: index,
    createdAt: index + 1,
    parts: [
      {
        id: `part_${toolName}_${index}`,
        sessionId: "session_1",
        runId: "run_1",
        messageId: `message_${toolName}_${index}`,
        kind: "tool_result" as const,
        sequence: 0,
        text: `${toolName} result ${index}\n${"x".repeat(600)}`,
        data: {
          callId: `call_${toolName}_${index}`,
          toolName,
        },
        createdAt: index + 1,
      },
    ],
  }))
}

function makeInput(
  timeline: ModelTimelineMessage[],
  compressibleToolNames: ReadonlySet<string>,
): ModelProjectionInput {
  return {
    systemPrompt: "You are a helpful assistant.",
    skillCatalog: [],
    activeSkills: [],
    contextWindow: 200,
    tools: [],
    timeline,
    compressibleToolNames,
  }
}

describe("integration: tool metadata drives compaction", () => {
  test("compresses older tool results when ToolDefinition.isCompressible is true", () => {
    const compressibleToolNames = deriveCompressibleToolNames([createReadTool()])
    const projection = buildModelTurnProjection(makeInput(makeTimeline("read", 7), compressibleToolNames))

    expect(compressibleToolNames.has("read")).toBe(true)
    expect(projection.microcompact).not.toBeNull()
    expect(projection.microcompact?.clearedCount).toBe(2)

    const outputs = projection.request.messages
      .filter((message) => message.role === "tool")
      .map((message) => (message.parts[0] as { output?: string }).output)

    expect(outputs.slice(0, 2)).toEqual([
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
    ])
    expect(outputs.slice(-5)).toEqual(
      Array.from({ length: 5 }, (_, index) => expect.stringContaining(`read result ${index + 2}`)),
    )
  })

  test("retains tool results when ToolDefinition.isCompressible is false", () => {
    const requestPermission = async () => ({ decision: "allow" as const })
    const compressibleToolNames = deriveCompressibleToolNames([createEditTool({ requestPermission })])
    const projection = buildModelTurnProjection(makeInput(makeTimeline("edit", 7), compressibleToolNames))

    expect(compressibleToolNames.size).toBe(0)
    expect(projection.microcompact).toBeNull()

    const outputs = projection.request.messages
      .filter((message) => message.role === "tool")
      .map((message) => (message.parts[0] as { output?: string }).output)

    expect(outputs).toHaveLength(7)
    for (let index = 0; index < outputs.length; index += 1) {
      expect(outputs[index]).toContain(`edit result ${index}`)
    }
  })
})

describe("integration: step-service metadata-driven microcompaction", () => {
  test("executeStep threads explicit compressible metadata for non-default tools", async () => {
    const session = createMemorySession({
      timeline: makeOrchestrationToolHistory("get_current_datetime", 7, "run_history"),
    })
    session.timeline.push(makeUserMessage(session.runId, 0, "What time is it?"))
    const captured = createExecuteStepModelCapture()
    const stepService = createOrchestrationStepService({
      session,
      model: captured.model,
      contextWindow: createFixedContextWindow(200),
      skill: createEmptySkillPort(),
      now: createMonotonicClock(),
    })

    const result = await stepService.executeStep({
      sessionId: session.sessionId,
      runId: session.runId,
      tools: createToolPort([
        {
          name: "get_current_datetime",
          description: "Get the current datetime",
          concurrency: "read-only",
          isCompressible: true,
        },
      ]),
      workspaceRoot: "/workspace",
      systemPrompt: "system",
      signal: new AbortController().signal,
      emit() {},
    })

    expect(result).toEqual({ status: "complete" })
    expect(readCompressibleToolNames(captured.requests[0])).toEqual(["get_current_datetime"])
    expect(captured.projectedToolOutputs[0]?.slice(0, 2)).toEqual([
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
    ])
    expect(captured.projectedToolOutputs[0]?.slice(-5)).toEqual(
      Array.from({ length: 5 }, (_, index) =>
        expect.stringContaining(`get_current_datetime result ${index + 2}`),
      ),
    )
  })

  test("executeStep preserves fallback when tools do not expose isCompressible metadata", async () => {
    const session = createMemorySession({
      timeline: makeOrchestrationToolHistory("read", 7, "run_history"),
    })
    session.timeline.push(makeUserMessage(session.runId, 0, "Read the file again"))
    const captured = createExecuteStepModelCapture()
    const stepService = createOrchestrationStepService({
      session,
      model: captured.model,
      contextWindow: createFixedContextWindow(200),
      skill: createEmptySkillPort(),
      now: createMonotonicClock(),
    })

    const result = await stepService.executeStep({
      sessionId: session.sessionId,
      runId: session.runId,
      tools: createToolPort([
        {
          name: "read",
          description: "Read a file",
          concurrency: "read-only",
        },
      ]),
      workspaceRoot: "/workspace",
      systemPrompt: "system",
      signal: new AbortController().signal,
      emit() {},
    })

    expect(result).toEqual({ status: "complete" })
    expect(captured.requests[0]?.compressibleToolNames).toBeUndefined()
    expect(captured.projectedToolOutputs[0]?.slice(0, 2)).toEqual([
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
    ])
  })

  test("executeStep honors explicit false metadata for default fallback tools", async () => {
    const session = createMemorySession({
      timeline: makeOrchestrationToolHistory("read", 7, "run_history"),
    })
    session.timeline.push(makeUserMessage(session.runId, 0, "Read the file again"))
    const captured = createExecuteStepModelCapture()
    const stepService = createOrchestrationStepService({
      session,
      model: captured.model,
      contextWindow: createFixedContextWindow(200),
      skill: createEmptySkillPort(),
      now: createMonotonicClock(),
    })

    const result = await stepService.executeStep({
      sessionId: session.sessionId,
      runId: session.runId,
      tools: createToolPort([
        {
          name: "read",
          description: "Read a file",
          concurrency: "read-only",
          isCompressible: false,
        },
      ]),
      workspaceRoot: "/workspace",
      systemPrompt: "system",
      signal: new AbortController().signal,
      emit() {},
    })

    expect(result).toEqual({ status: "complete" })
    expect(readCompressibleToolNames(captured.requests[0])).toEqual([])
    expect(captured.projectedToolOutputs[0]).toHaveLength(7)
    for (let index = 0; index < 7; index += 1) {
      expect(captured.projectedToolOutputs[0]?.[index]).toContain(`read result ${index}`)
    }
  })

  test("compactSession threads explicit compressible metadata into projection and summary requests", async () => {
    const session = createMemorySession({
      timeline: makeOrchestrationToolHistory("get_current_datetime", 7, "run_history"),
    })
    const captured = createCompactionModelCapture()
    const stepService = createOrchestrationStepService({
      session,
      model: captured.model,
      contextWindow: createFixedContextWindow(200),
      skill: createEmptySkillPort(),
      now: createMonotonicClock(),
    })

    const result = await stepService.compactSession({
      sessionId: session.sessionId,
      runId: session.runId,
      tools: createToolPort([
        {
          name: "get_current_datetime",
          description: "Get the current datetime",
          concurrency: "read-only",
          isCompressible: true,
        },
      ]),
      workspaceRoot: "/workspace",
      systemPrompt: "system",
      signal: new AbortController().signal,
      emit() {},
    })

    expect(result).toEqual({ status: "completed" })
    expect(captured.projectRequests).toHaveLength(2)
    expect(captured.projectRequests.map((request) => readCompressibleToolNames(request))).toEqual([
      ["get_current_datetime"],
      ["get_current_datetime"],
    ])
    expect(captured.summaryRequests).toHaveLength(1)
    expect(readCompressibleToolNames(captured.summaryRequests[0])).toEqual(["get_current_datetime"])
    expect(captured.summaryProjectedToolOutputs[0]?.slice(0, 2)).toEqual([
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
    ])
  })
})

function createExecuteStepModelCapture() {
  const requests: OrchestrationModelTurnRequest[] = []
  const projectedToolOutputs: string[][] = []

  const model: OrchestrationModelPort = {
    async *streamTurn(request) {
      requests.push(request)
      projectedToolOutputs.push(readProjectedToolOutputs(request))
    },
  }

  return {
    model,
    requests,
    projectedToolOutputs,
  }
}

function createCompactionModelCapture() {
  const projectRequests: Array<Omit<OrchestrationModelTurnRequest, "signal">> = []
  const summaryRequests: OrchestrationModelTurnRequest[] = []
  const summaryProjectedToolOutputs: string[][] = []

  const model: OrchestrationModelPort = {
    projectTurn(request) {
      projectRequests.push(request)
      return { inputTokens: 800 }
    },
    async *streamTurn(request) {
      summaryRequests.push(request)
      summaryProjectedToolOutputs.push(readProjectedToolOutputs(request))
      yield { type: "text.delta" as const, text: "Primary Request\nSummary" }
      yield {
        type: "usage" as const,
        inputTokens: 200,
        outputTokens: 20,
        source: "estimated" as const,
      }
    },
  }

  return {
    model,
    projectRequests,
    summaryRequests,
    summaryProjectedToolOutputs,
  }
}

function readProjectedToolOutputs(request: Omit<OrchestrationModelTurnRequest, "signal">) {
  return buildModelTurnProjection(request)
    .request.messages.filter((message) => message.role === "tool")
    .map((message) => (message.parts[0] as { output?: string }).output ?? "")
}

function readCompressibleToolNames(
  request:
    | Pick<OrchestrationModelTurnRequest, "compressibleToolNames">
    | undefined,
) {
  return request?.compressibleToolNames ? Array.from(request.compressibleToolNames).sort() : undefined
}

function createEmptySkillPort(): OrchestrationSkillPort {
  return {
    async listCatalog() {
      return []
    },
    async loadSkill() {
      throw new Error("Unexpected skill load")
    },
  }
}

function createFixedContextWindow(contextWindow: number): OrchestrationContextWindowPort {
  return {
    getContextWindow() {
      return contextWindow
    },
  }
}

function createToolPort(tools: ReturnType<OrchestrationToolPort["list"]>): OrchestrationToolPort {
  return {
    list() {
      return tools
    },
    async execute() {
      throw new Error("Unexpected tool execution")
    },
    async executeBatch() {
      return []
    },
  }
}

function makeOrchestrationToolHistory(
  toolName: string,
  count: number,
  runId: string,
): OrchestrationTimelineMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    runId,
    role: "assistant" as const,
    sequence: index,
    parts: [
      {
        kind: "tool_result",
        text: `${toolName} result ${index}\n${"x".repeat(600)}`,
        data: {
          callId: `call_${toolName}_${index}`,
          toolName,
        },
      },
    ],
  }))
}

function makeUserMessage(runId: string, sequence: number, text: string): OrchestrationTimelineMessage {
  return {
    runId,
    role: "user",
    sequence,
    parts: [{ kind: "text", text }],
  }
}

function createMemorySession(input: { timeline: OrchestrationTimelineMessage[] }) {
  const sessionId = "session_compaction"
  const runId = "run_compaction"
  let nextMessageId = 0
  let nextPartId = 0
  const timeline = [...input.timeline]
  const messageIds = new Map<string, OrchestrationTimelineMessage>()
  const partIds = new Map<string, OrchestrationPartRecord>()
  const runs = new Map<string, OrchestrationRunRecord>([
    [
      runId,
      {
        id: runId,
        sessionId,
        createdAt: 1,
        status: "running",
        activeSkills: [],
        inputTokens: 0,
        outputTokens: 0,
        tokenUsageSource: null,
      },
    ],
  ])

  const session: OrchestrationSessionPort & {
    sessionId: string
    runId: string
    timeline: OrchestrationTimelineMessage[]
  } = {
    sessionId,
    runId,
    timeline,
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
      const run = runs.get(requestedRunId)
      if (!run) {
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
    createRun(inputValue) {
      const run: OrchestrationRunRecord = {
        id: inputValue.id,
        sessionId: inputValue.sessionId,
        createdAt: inputValue.createdAt,
        status: inputValue.status,
        activeSkills: inputValue.activeSkills ?? [],
        inputTokens: inputValue.inputTokens ?? 0,
        outputTokens: inputValue.outputTokens ?? 0,
        tokenUsageSource: inputValue.tokenUsageSource ?? null,
      }
      runs.set(run.id, run)
      return run
    },
    createAssistantMessage(inputValue) {
      const id = `assistant_message_${nextMessageId++}`
      const message: OrchestrationTimelineMessage = {
        runId: inputValue.runId,
        role: "assistant",
        sequence: inputValue.sequence,
        parts: [],
      }
      timeline.push(message)
      messageIds.set(id, message)
      return { id }
    },
    createCompactionMessage(inputValue) {
      const id = `compaction_message_${nextMessageId++}`
      const message: OrchestrationTimelineMessage = {
        runId: inputValue.runId,
        role: "compaction",
        sequence: inputValue.sequence,
        parts: [],
      }
      timeline.push(message)
      messageIds.set(id, message)
      return { id }
    },
    createMessagePart(inputValue) {
      const message = messageIds.get(inputValue.messageId)
      if (!message) {
        throw new Error(`Unknown message ${inputValue.messageId}`)
      }

      const part: OrchestrationPartRecord = {
        id: `part_${nextPartId++}`,
        kind: inputValue.kind,
        text: inputValue.text ?? null,
        data: inputValue.data,
      }
      message.parts.push(part)
      partIds.set(part.id, part)
      return part
    },
    updateMessagePart(inputValue) {
      const part = partIds.get(inputValue.partId)
      if (!part) {
        throw new Error(`Unknown part ${inputValue.partId}`)
      }

      if (inputValue.text !== undefined) {
        part.text = inputValue.text
      }
      if (inputValue.data !== undefined) {
        part.data = inputValue.data
      }
      return part
    },
    recordRunTokenUsage(inputValue) {
      const run = runs.get(inputValue.runId)
      if (!run) {
        throw new Error(`Unknown run ${inputValue.runId}`)
      }

      run.inputTokens = inputValue.inputTokens
      run.outputTokens = inputValue.outputTokens
      run.tokenUsageSource = inputValue.tokenUsageSource
      return run
    },
    transitionRunToRunning(requestedRunId) {
      const run = runs.get(requestedRunId)
      if (!run) {
        throw new Error(`Unknown run ${requestedRunId}`)
      }

      run.status = "running"
      return run
    },
    completeRun(requestedRunId) {
      const run = runs.get(requestedRunId)
      if (!run) {
        throw new Error(`Unknown run ${requestedRunId}`)
      }

      run.status = "completed"
      return run
    },
    failRun(inputValue) {
      const run = runs.get(inputValue.runId)
      if (!run) {
        throw new Error(`Unknown run ${inputValue.runId}`)
      }

      run.status = "failed"
      return run
    },
    cancelRun(requestedRunId) {
      const run = runs.get(requestedRunId)
      if (!run) {
        throw new Error(`Unknown run ${requestedRunId}`)
      }

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
