import { describe, expect, test } from "bun:test"
import {
  createModelProvider,
  createModelRuntimeApi,
  type ProviderTurnRequest,
} from "../../src/model"
import {
  createOrchestrationStepService,
  type OrchestrationContextWindowPort,
  type OrchestrationPartRecord,
  type OrchestrationAgentProfilePort,
  type OrchestrationRunRecord,
  type OrchestrationSessionPort,
  type OrchestrationSkillPort,
  type OrchestrationTranscriptMessage,
  type OrchestrationToolPort,
} from "../../src/orchestration"
import { buildToolDeniedMessage } from "../../src/agent/application/tool-permission-check"

describe("orchestration step service tool permission interception", () => {
  test("returns denied main-agent tools as model-facing errors without executing them", async () => {
    const session = createMemorySession({
      currentAgent: "plan",
      userText: "Inspect the workspace",
    })
    const { model, requests } = createSequencedModelProvider([
      async function* () {
        yield {
          type: "tool.call" as const,
          callId: "call_shell",
          name: "shell",
          inputText: '{"command":"pwd"}',
        }
      },
      async function* () {
        yield {
          type: "text.delta" as const,
          text: "I will use a different tool.",
        }
      },
    ])
    const tools = createToolPortStub({
      read: "README_CONTENT",
      shell: "SHOULD_NOT_RUN",
      lsp_symbols: "SHOULD_NOT_RUN",
    })
    const stepService = createOrchestrationStepService({
      session,
      model,
      agentProfiles: createAgentProfilesStub({
        shell: false,
      }),
      contextWindow: createContextWindowStub(),
      skill: createSkillPortStub(),
      now: createMonotonicClock(),
    })

    await expect(executeStep({ stepService, session, tools })).resolves.toEqual({ status: "repeat" })
    await expect(executeStep({ stepService, session, tools })).resolves.toEqual({ status: "complete" })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["read", "shell", "lsp_symbols"])
    expect(tools.executedBatches).toEqual([])
    expect(session.listTranscript(session.sessionId)[1]?.parts).toMatchObject([
      {
        kind: "tool_call",
        data: {
          callId: "call_shell",
          toolName: "shell",
        },
      },
      {
        kind: "tool_result",
        text: buildToolDeniedMessage("shell", "plan"),
        data: {
          callId: "call_shell",
          toolName: "shell",
          output: buildToolDeniedMessage("shell", "plan"),
          isError: true,
        },
      },
    ])
    expect(readToolResultParts(requests[1]!)).toEqual([
      expect.objectContaining({
        toolName: "shell",
        isError: true,
        output: expect.stringContaining("Tool 'shell' is not available in plan mode"),
      }),
    ])
  })

  test("plan mode keeps memory tools visible while denying mutating memory calls", async () => {
    const session = createMemorySession({
      currentAgent: "plan",
      userText: "Inspect memory",
    })
    const { model, requests } = createSequencedModelProvider([
      async function* () {
        yield {
          type: "tool.call" as const,
          callId: "call_memory_view",
          name: "memory_view",
          inputText: '{"target":"agent"}',
        }
        yield {
          type: "tool.call" as const,
          callId: "call_memory_add",
          name: "memory_add",
          inputText: '{"target":"agent","content":"keep this"}',
        }
      },
      async function* () {
        yield {
          type: "text.delta" as const,
          text: "Memory inspection complete.",
        }
      },
    ])
    const tools = createToolPortStub({
      memory_view: "MEMORY_VIEW_OUTPUT",
      memory_add: "SHOULD_NOT_RUN",
    }, true)
    const stepService = createOrchestrationStepService({
      session,
      model,
      agentProfiles: createAgentProfilesStub({
        memory_add: false,
      }),
      contextWindow: createContextWindowStub(),
      skill: createSkillPortStub(),
      now: createMonotonicClock(),
    })

    await expect(executeStep({ stepService, session, tools })).resolves.toEqual({ status: "repeat" })
    await expect(executeStep({ stepService, session, tools })).resolves.toEqual({ status: "complete" })

    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["memory_add", "memory_view"]),
    )
    expect(tools.executedBatches).toEqual([["memory_view"]])
    expect(readToolResultParts(requests[1]!).map((part) => part.toolName)).toEqual([
      "memory_view",
      "memory_add",
    ])
    expect(readToolResultParts(requests[1]!)).toEqual([
      expect.objectContaining({
        toolName: "memory_view",
        output: "MEMORY_VIEW_OUTPUT",
      }),
      expect.objectContaining({
        toolName: "memory_add",
        isError: true,
        output: expect.stringContaining("Tool 'memory_add' is not available in plan mode"),
      }),
    ])
  })

  test("executes allowed tools while denying wildcard-matched main-agent tools", async () => {
    const session = createMemorySession({
      currentAgent: "plan",
      userText: "Inspect README and symbols",
    })
    const { model, requests } = createSequencedModelProvider([
      async function* () {
        yield {
          type: "tool.call" as const,
          callId: "call_read",
          name: "read",
          inputText: '{"path":"README.md"}',
        }
        yield {
          type: "tool.call" as const,
          callId: "call_lsp",
          name: "lsp_symbols",
          inputText: '{"filePath":"src/index.ts"}',
        }
      },
      async function* () {
        yield {
          type: "text.delta" as const,
          text: "Done.",
        }
      },
    ])
    const tools = createToolPortStub({
      read: "README_CONTENT",
      shell: "unused",
      lsp_symbols: "SHOULD_NOT_RUN",
    })
    const stepService = createOrchestrationStepService({
      session,
      model,
      agentProfiles: createAgentProfilesStub({
        lsp_symbols: false,
      }),
      contextWindow: createContextWindowStub(),
      skill: createSkillPortStub(),
      now: createMonotonicClock(),
    })

    await expect(executeStep({ stepService, session, tools })).resolves.toEqual({ status: "repeat" })
    await expect(executeStep({ stepService, session, tools })).resolves.toEqual({ status: "complete" })

    expect(tools.executedBatches).toEqual([["read"]])
    expect(readToolResultParts(requests[1]!).map((part) => part.toolName)).toEqual([
      "read",
      "lsp_symbols",
    ])
    expect(readToolResultParts(requests[1]!)).toEqual([
      expect.objectContaining({
        toolName: "read",
        output: "README_CONTENT",
      }),
      expect.objectContaining({
        toolName: "lsp_symbols",
        isError: true,
        output: expect.stringContaining("Tool 'lsp_symbols' is not available in plan mode"),
      }),
    ])
  })
})

function createSequencedModelProvider(
  steps: Array<(request: ProviderTurnRequest) => AsyncIterable<unknown>>,
) {
  const requests: ProviderTurnRequest[] = []
  let index = 0

  const provider = {
    async *streamTurn(request: ProviderTurnRequest) {
      requests.push(request)
      const step = steps[index]
      index += 1

      if (!step) {
        return
      }

      for await (const event of step(request)) {
        yield event as never
      }
    },
  }

  return {
    model: createModelProvider({
      runtime: createModelRuntimeApi(provider),
    }),
    requests,
  }
}

function readToolResultParts(request: ProviderTurnRequest) {
  return request.messages.flatMap((message) =>
    message.role !== "tool"
      ? []
      : message.parts.filter(
          (part): part is Extract<(typeof message.parts)[number], { type: "tool_result" }> =>
            part.type === "tool_result",
        ),
  )
}

function executeStep(input: {
  stepService: ReturnType<typeof createOrchestrationStepService>
  session: ReturnType<typeof createMemorySession>
  tools: OrchestrationToolPort & { executedBatches: string[][] }
}) {
  return input.stepService.executeStep({
    sessionId: input.session.sessionId,
    runId: input.session.runId,
    tools: input.tools,
    workspaceRoot: "/workspace/project",
    systemPrompt: "static system prompt",
    signal: new AbortController().signal,
    emit() {},
  })
}

function createAgentProfilesStub(accessByToolName: Record<string, boolean>): OrchestrationAgentProfilePort {
  return {
    async getResolvedProfile() {
      return {}
    },
    async checkToolAccess(input) {
      if (accessByToolName[input.toolName] !== false) {
        return { allowed: true }
      }

      return {
        allowed: false,
        deniedMessage: buildToolDeniedMessage(input.toolName, input.agentName),
      }
    },
  }
}

function createToolPortStub(outputs: Record<string, string>, includeMemoryTools = false) {
  const executedBatches: string[][] = []

  const toolPort: OrchestrationToolPort & { executedBatches: string[][] } = {
    executedBatches,
    list(): ReturnType<OrchestrationToolPort["list"]> {
      return [
        {
          name: "read",
          description: "Read a file",
          concurrency: "read-only",
        },
        {
          name: "shell",
          description: "Run shell commands",
          concurrency: "mutating",
        },
        {
          name: "lsp_symbols",
          description: "Inspect symbols",
          concurrency: "read-only",
        },
        ...(includeMemoryTools
          ? [
              {
                name: "memory_add",
                description: "Save memory",
                concurrency: "mutating" as const,
              },
              {
                name: "memory_view",
                description: "View memory",
                concurrency: "read-only" as const,
              },
            ]
          : []),
      ]
    },
    async execute() {
      throw new Error("Unexpected direct tool execution")
    },
    async executeBatch(input) {
      executedBatches.push(input.calls.map((call) => call.toolName))
      return input.calls.map((call) => ({
        callId: call.callId,
        toolName: call.toolName,
        output: outputs[call.toolName] ?? `${call.toolName}_OUTPUT`,
      }))
    },
  }

  return toolPort
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

function createMemorySession(input: {
  currentAgent?: string
  userText: string
}) {
  const sessionId = "session_tool_permission"
  const runId = `run_tool_permission_${crypto.randomUUID()}`
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

      if (partInput.text !== undefined) {
        part.text = partInput.text
      }
      if (partInput.data !== undefined) {
        part.data = partInput.data
      }
      return part
    },
    recordRunTokenUsage(partInput) {
      run.inputTokens = partInput.inputTokens
      run.outputTokens = partInput.outputTokens
      run.tokenUsageSource = partInput.tokenUsageSource
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
