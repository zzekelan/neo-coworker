import { describe, expect, test } from "bun:test"
import {
  createSubAgentContext,
  createSubAgentRun,
  type CreateSubAgentRunInput,
} from "../../src/agent"

type SessionPort = CreateSubAgentRunInput["session"]
type SessionRecord = ReturnType<SessionPort["getSession"]>
type RunRecord = ReturnType<SessionPort["getRun"]>
type TranscriptMessage = ReturnType<SessionPort["listTranscript"]>[number]
type TranscriptPart = TranscriptMessage["parts"][number]

function cloneSessionRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    activeSkills: [...record.activeSkills],
  }
}

function cloneRunRecord(record: RunRecord): RunRecord {
  return {
    ...record,
    activeSkills: [...record.activeSkills],
  }
}

function cloneTranscriptMessage(message: TranscriptMessage): TranscriptMessage {
  return {
    ...message,
    parts: message.parts.map((part) => ({ ...part })),
  }
}

function createSessionPortStub(input: {
  sessionId: string
  transcript?: TranscriptMessage[]
  activeSkills?: string[]
}): SessionPort {
  const sessions = new Map<string, SessionRecord>([
    [
      input.sessionId,
      {
        id: input.sessionId,
        workspaceRoot: "/workspace",
        activeSkills: [...(input.activeSkills ?? [])],
      },
    ],
  ])
  const transcripts = new Map<string, TranscriptMessage[]>([
    [input.sessionId, (input.transcript ?? []).map(cloneTranscriptMessage)],
  ])
  const runs = new Map<string, RunRecord>()
  const messages = new Map<string, TranscriptMessage>()
  const parts = new Map<string, TranscriptPart>()
  let messageCounter = 0
  let partCounter = 0

  const getSessionRecord = (sessionId: string) => {
    const existing = sessions.get(sessionId)
    if (existing) {
      return existing
    }

    const created: SessionRecord = {
      id: sessionId,
      workspaceRoot: "/workspace",
      activeSkills: [],
    }
    sessions.set(sessionId, created)
    return created
  }

  const getTranscript = (sessionId: string) => {
    const existing = transcripts.get(sessionId)
    if (existing) {
      return existing
    }

    const created: TranscriptMessage[] = []
    transcripts.set(sessionId, created)
    return created
  }

  const ensureRun = (runId: string) => {
    const existing = runs.get(runId)
    if (existing) {
      return existing
    }

    const created: RunRecord = {
      id: runId,
      sessionId: input.sessionId,
      createdAt: 0,
      status: "queued",
      activeSkills: [],
      inputTokens: 0,
      outputTokens: 0,
      tokenUsageSource: null,
    }
    runs.set(runId, created)
    return created
  }

  const mutateRun = (runId: string, update: Partial<RunRecord>) => {
    const run = ensureRun(runId)
    Object.assign(run, update)
    return cloneRunRecord(run)
  }

  const createMessage = (inputMessage: {
    sessionId: string
    runId: string
    role: TranscriptMessage["role"]
    sequence: number
  }) => {
    const messageId = `message-${++messageCounter}`
    const message: TranscriptMessage = {
      runId: inputMessage.runId,
      role: inputMessage.role,
      sequence: inputMessage.sequence,
      parts: [],
    }
    getTranscript(inputMessage.sessionId).push(message)
    messages.set(messageId, message)
    return { id: messageId }
  }

  return {
    storageIdentity: "session-port-stub",
    getSession(sessionId) {
      return cloneSessionRecord(getSessionRecord(sessionId))
    },
    getRun(runId) {
      return cloneRunRecord(ensureRun(runId))
    },
    listTranscript(sessionId) {
      return getTranscript(sessionId).map(cloneTranscriptMessage)
    },
    createRun(run) {
      const record: RunRecord = {
        id: run.id,
        sessionId: run.sessionId,
        createdAt: run.createdAt,
        status: run.status,
        activeSkills: [...(run.activeSkills ?? [])],
        inputTokens: run.inputTokens ?? 0,
        outputTokens: run.outputTokens ?? 0,
        tokenUsageSource: run.tokenUsageSource ?? null,
      }
      runs.set(run.id, record)
      return cloneRunRecord(record)
    },
    createAssistantMessage(message) {
      return createMessage({
        sessionId: message.sessionId,
        runId: message.runId,
        role: "assistant",
        sequence: message.sequence,
      })
    },
    createSyntheticMessage(message) {
      return createMessage({
        sessionId: message.sessionId,
        runId: message.runId,
        role: "synthetic",
        sequence: message.sequence,
      })
    },
    createMessagePart(part) {
      const message = messages.get(part.messageId)
      if (!message) {
        throw new Error(`Unknown message: ${part.messageId}`)
      }

      const partId = `part-${++partCounter}`
      const storedPart: TranscriptPart = {
        kind: part.kind,
        text: part.text ?? null,
        data: part.data,
      }
      message.parts.push(storedPart)
      parts.set(partId, storedPart)
      return {
        id: partId,
        kind: storedPart.kind,
        text: storedPart.text,
        data: storedPart.data,
      }
    },
    updateMessagePart(update) {
      const part = parts.get(update.partId)
      if (!part) {
        throw new Error(`Unknown part: ${update.partId}`)
      }

      if (Object.hasOwn(update, "text")) {
        part.text = update.text ?? null
      }
      if (Object.hasOwn(update, "data")) {
        part.data = update.data
      }

      return {
        id: update.partId,
        kind: part.kind,
        text: part.text,
        data: part.data,
      }
    },
    recordRunTokenUsage(update) {
      return mutateRun(update.runId, {
        inputTokens: update.inputTokens,
        outputTokens: update.outputTokens,
        tokenUsageSource: update.tokenUsageSource,
      })
    },
    transitionRunToRunning(runId) {
      return mutateRun(runId, { status: "running" })
    },
    completeRun(runId) {
      return mutateRun(runId, { status: "completed" })
    },
    failRun(run) {
      return mutateRun(run.runId, {
        status: "failed",
      })
    },
    cancelRun(runId) {
      return mutateRun(runId, { status: "cancelled" })
    },
  }
}

function createSubAgentRunInput(overrides: Partial<CreateSubAgentRunInput> = {}): CreateSubAgentRunInput {
  return {
    profile: {
      name: "explore",
      tools: ["read"],
      skills: [],
    },
    prompt: "Inspect the transcript",
    sessionId: "session-1",
    parentRunId: "parent-run",
    workspaceRoot: "/workspace",
    parentTools: {
      list() {
        return []
      },
      async execute() {
        throw new Error("parent tools should not execute in this test")
      },
      async executeBatch() {
        return []
      },
    },
    model: {
      async *streamTurn() {
        throw new Error("model should not stream in this test")
      },
    },
    session: createSessionPortStub({ sessionId: "session-1" }),
    skill: {
      async listCatalog() {
        return []
      },
      async loadSkill(input) {
        return {
          name: input.name,
          instructions: "",
          path: `/skills/${input.name}.md`,
        }
      },
    },
    contextWindow: {
      getContextWindow() {
        return 16000
      },
    },
    createQueuedRun() {},
    buildAgentAwarePrompt() {
      return "system prompt"
    },
    createStepService() {
      return {
        isAbortError() {
          return false
        },
        isDetachedError() {
          return false
        },
        initializeRun() {},
        completeRun() {},
        failRun() {},
        cancelRun() {
          return false
        },
        async executeStep() {
          return { status: "complete" }
        },
      }
    },
    createToolBatchExecutor() {
      return {
        async execute() {
          return []
        },
      }
    },
    createToolRuntime({ tools }) {
      return {
        list() {
          return tools
        },
        async execute() {
          return { output: "" }
        },
      }
    },
    createToolProvider({ runtime }) {
      return {
        list() {
          return runtime.list()
        },
        execute(input) {
          return runtime.execute(input)
        },
      }
    },
    ...overrides,
  }
}

describe("createSubAgentContext", () => {
  test("returns a unique subRunId while preserving sessionId", () => {
    const first = createSubAgentContext({ sessionId: "session-1" })
    const second = createSubAgentContext({ sessionId: "session-1" })

    expect(first.sessionId).toBe("session-1")
    expect(second.sessionId).toBe("session-1")
    expect(first.subRunId).toMatch(/^run_/)
    expect(second.subRunId).toMatch(/^run_/)
    expect(first.subRunId).not.toBe(second.subRunId)
  })

  test("propagates parent aborts to the child signal", () => {
    const parent = new AbortController()
    const context = createSubAgentContext({
      sessionId: "session-1",
      signal: parent.signal,
    })

    expect(context.signal.aborted).toBe(false)

    parent.abort("stop")

    expect(context.signal.aborted).toBe(true)
    expect(context.signal.reason).toBe("stop")
  })

  test("immediately aborts when the parent signal is already aborted", () => {
    const parent = new AbortController()
    parent.abort("already-stopped")

    const context = createSubAgentContext({
      sessionId: "session-1",
      signal: parent.signal,
    })

    expect(context.signal.aborted).toBe(true)
    expect(context.signal.reason).toBe("already-stopped")
  })
})

describe("createSubAgentRun", () => {
  test("scoped sub-agent transcript only includes its own run and still returns final assistant output", async () => {
    const parentTranscript: TranscriptMessage[] = [
      {
        runId: "parent-run",
        role: "user",
        sequence: 0,
        parts: [{ kind: "text", text: "parent prompt" }],
      },
      {
        runId: "sibling-run",
        role: "assistant",
        sequence: 1,
        parts: [{ kind: "text", text: "sibling answer" }],
      },
    ]
    const session = createSessionPortStub({
      sessionId: "session-1",
      transcript: parentTranscript,
    })
    let scopedTranscriptBeforeWrite: TranscriptMessage[] = []
    let scopedTranscriptAfterWrite: TranscriptMessage[] = []

    const output = await createSubAgentRun(
      createSubAgentRunInput({
        session,
        createStepService({ session }) {
          return {
            isAbortError() {
              return false
            },
            isDetachedError() {
              return false
            },
            initializeRun() {},
            completeRun() {},
            failRun() {},
            cancelRun() {
              return false
            },
            async executeStep(stepInput) {
              scopedTranscriptBeforeWrite = session.listTranscript(stepInput.sessionId)

              const assistantMessage = session.createAssistantMessage({
                sessionId: stepInput.sessionId,
                runId: stepInput.runId,
                sequence: 2,
                createdAt: 2,
              })
              session.createMessagePart({
                sessionId: stepInput.sessionId,
                runId: stepInput.runId,
                messageId: assistantMessage.id,
                kind: "text",
                sequence: 0,
                text: "child-only output",
                createdAt: 2,
              })

              scopedTranscriptAfterWrite = session.listTranscript(stepInput.sessionId)

              return { status: "complete" }
            },
          }
        },
      }),
    )

    expect(scopedTranscriptBeforeWrite).toEqual([])
    expect(scopedTranscriptAfterWrite).toHaveLength(1)
    expect(scopedTranscriptAfterWrite[0]?.runId).not.toBe("parent-run")
    expect(scopedTranscriptAfterWrite[0]?.runId).not.toBe("sibling-run")
    expect(scopedTranscriptAfterWrite[0]?.role).toBe("assistant")
    expect(scopedTranscriptAfterWrite[0]?.parts[0]?.text).toBe("child-only output")
    expect(output).toBe("child-only output")

    const parentVisibleTranscript = session.listTranscript("session-1")
    expect(parentVisibleTranscript).toHaveLength(3)
    expect(parentVisibleTranscript.map((message) => message.runId)).toEqual([
      "parent-run",
      "sibling-run",
      scopedTranscriptAfterWrite[0]!.runId,
    ])
  })
})
