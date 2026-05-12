import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSubAgentRun,
  type CreateSubAgentRunInput,
} from "../../src/agent"
import {
  buildAgentAwarePrompt,
  createOrchestrationStepService,
  createOrchestrationToolBatchExecutor,
} from "../../src/orchestration"
import {
  createResultStore,
  createToolProviderFromRuntime,
  createToolRuntimeApi,
  type ToolObserverEvent,
} from "../../src/tool"

const TAIL_SENTINEL = "SUBAGENT_WEBFETCH_TAIL_SENTINEL"
const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("subagent tool result size management", () => {
  test("truncates and persists oversized subagent-scoped webfetch results before timeline replay", async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const observerEvents: ToolObserverEvent[] = []
    const session = createSessionPortStub({ sessionId: "parent_session" })
    const oversizedOutput = `${"A".repeat(60_000)}${TAIL_SENTINEL}${"Z".repeat(1_000)}`
    let serializedSecondRequest = ""

    await withDeterministicSubRunId("abc", async () => {
      await createSubAgentRun(
        createSubAgentRunInput({
          session,
          sessionId: "parent_session",
          workspaceRoot,
          profile: {
            name: "source-researcher",
            tools: ["webfetch"],
            skills: [],
          },
          parentTools: {
            list() {
              return [
                {
                  name: "webfetch",
                  description: "Fetch a URL",
                  concurrency: "read-only",
                  resultSizeLimit: 100_000,
                },
              ]
            },
            async execute(input) {
              expect(input.toolName).toBe("webfetch")
              return { output: oversizedOutput }
            },
            async executeBatch() {
              throw new Error("subagent scoped batch should execute through its filtered provider")
            },
          },
          model: {
            async *streamTurn(request) {
              if (request.timeline.some((message) => message.parts.some((part) => part.kind === "tool_result"))) {
                serializedSecondRequest = JSON.stringify(request)
                yield { type: "text.delta", text: "done" }
                return
              }

              yield {
                type: "tool.call",
                callId: "call_webfetch",
                name: "webfetch",
                inputText: JSON.stringify({ url: "https://example.test/large" }),
              }
            },
          },
          createQueuedRun({ subRunId, prompt, activeSkills, createdAt, parentRunId }) {
            session.setSession({
              sessionId: "ses_abc",
              activeSkills,
              parentSessionId: "parent_session",
            })
            session.createRun({
              id: subRunId,
              sessionId: "ses_abc",
              trigger: "summarize",
              status: "queued",
              createdAt,
              activeSkills,
            })
            session.setRunParentRunId({ runId: subRunId, parentRunId })
            session.seedTimelineMessage({
              sessionId: "ses_abc",
              runId: subRunId,
              role: "user",
              sequence: 0,
              parts: [{ kind: "text", text: prompt }],
            })

            return { subSessionId: "ses_abc" }
          },
          toolObserver: {
            recordToolEvent(event: ToolObserverEvent) {
              observerEvents.push(event)
            },
          },
          createResultStore({ sessionId, runId }) {
            return createResultStore({
              workspaceRoot,
              observer: {
                recordToolEvent(event: ToolObserverEvent) {
                  observerEvents.push(event)
                },
              },
              sessionId,
              runId,
            })
          },
        }),
      )
    })

    const timelineJson = JSON.stringify(session.listTimeline("ses_abc"))
    const toolResultPart = session
      .listTimeline("ses_abc")
      .flatMap((message) => message.parts)
      .find((part) => part.kind === "tool_result")
    const metadata = readMetadata(toolResultPart?.data)
    const savedPath = readRequiredString(metadata, "savedPath")

    expect(serializedSecondRequest).not.toBe("")
    expect(serializedSecondRequest).not.toContain(TAIL_SENTINEL)
    expect(serializedSecondRequest).toContain("Result truncated")
    expect(timelineJson).not.toContain(TAIL_SENTINEL)
    expect(metadata).toMatchObject({
      truncated: true,
      originalSize: Buffer.byteLength(oversizedOutput, "utf8"),
      truncatedSize: 50_000,
      resultSizeLimit: 50_000,
    })
    expect(savedPath).toMatch(/^\.ncoworker\/tool-results\/ses_abc\/webfetch\/[a-f0-9]{64}\.txt$/)
    expect(serializedSecondRequest).toContain(savedPath)
    expect(await readFile(join(workspaceRoot, savedPath), "utf8")).toBe(oversizedOutput)

    const truncationEvent = observerEvents.find((event) => event.type === "budget.result_truncated")
    expect(truncationEvent).toBeDefined()
    expect(truncationEvent).toMatchObject({
      type: "budget.result_truncated",
      sessionId: "ses_abc",
      runId: "run_abc",
      toolName: "webfetch",
      originalSize: Buffer.byteLength(oversizedOutput, "utf8"),
      truncatedSize: 50_000,
      limit: 50_000,
      savedPath,
    })
  })
})

function createSubAgentRunInput(
  overrides: Partial<CreateSubAgentRunInput> & Record<string, unknown> = {},
): CreateSubAgentRunInput {
  return {
    profile: {
      name: "source-researcher",
      tools: ["webfetch"],
      skills: [],
    },
    prompt: "Fetch the large source",
    sessionId: "parent_session",
    parentRunId: "parent_run",
    workspaceRoot: "/workspace",
    parentTools: {
      list() {
        return []
      },
      async execute() {
        throw new Error("parent tool execute not configured")
      },
      async executeBatch() {
        return []
      },
    },
    model: {
      async *streamTurn() {
        throw new Error("model not configured")
      },
    },
    session: createSessionPortStub({ sessionId: "parent_session" }),
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
        return 128_000
      },
    },
    createQueuedRun() {
      return { subSessionId: "ses_abc" }
    },
    buildAgentAwarePrompt,
    createStepService: createOrchestrationStepService,
    createToolBatchExecutor: createOrchestrationToolBatchExecutor,
    createToolRuntime: createToolRuntimeApi,
    createToolProvider: createToolProviderFromRuntime,
    ...overrides,
  }
}

type SessionPort = CreateSubAgentRunInput["session"]
type SessionPortStub = SessionPort & {
  setSession(input: { sessionId: string; activeSkills?: string[]; parentSessionId?: string }): void
  setRunParentRunId(input: { runId: string; parentRunId: string | null }): void
  seedTimelineMessage(input: {
    sessionId: string
    runId: string
    role: TimelineMessage["role"]
    sequence: number
    parts: TimelinePart[]
  }): void
}
type SessionRecord = ReturnType<SessionPort["getSession"]>
type RunRecord = ReturnType<SessionPort["getRun"]>
type TimelineMessage = ReturnType<SessionPort["listTimeline"]>[number]
type TimelinePart = TimelineMessage["parts"][number]

function createSessionPortStub(input: { sessionId: string; activeSkills?: string[] }): SessionPortStub {
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
  const timelines = new Map<string, TimelineMessage[]>([[input.sessionId, []]])
  const runs = new Map<string, RunRecord>()
  const runParentIds = new Map<string, string | null>()
  const messages = new Map<string, TimelineMessage>()
  const parts = new Map<string, TimelinePart>()
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
  const getTimeline = (sessionId: string) => {
    const existing = timelines.get(sessionId)
    if (existing) {
      return existing
    }

    const created: TimelineMessage[] = []
    timelines.set(sessionId, created)
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
    runParentIds.set(runId, null)
    return created
  }
  const cloneTimeline = (message: TimelineMessage): TimelineMessage => ({
    ...message,
    parts: message.parts.map((part) => ({ ...part })),
  })
  const createMessage = (messageInput: {
    sessionId: string
    runId: string
    role: TimelineMessage["role"]
    sequence: number
  }) => {
    const messageId = `message-${++messageCounter}`
    const message: TimelineMessage = {
      runId: messageInput.runId,
      role: messageInput.role,
      sequence: messageInput.sequence,
      parts: [],
    }
    getTimeline(messageInput.sessionId).push(message)
    messages.set(messageId, message)
    return { id: messageId }
  }

  return {
    storageIdentity: "subagent-tool-result-size-test",
    getSession(sessionId) {
      const session = getSessionRecord(sessionId)
      return { ...session, activeSkills: [...session.activeSkills] }
    },
    getRun(runId) {
      const run = ensureRun(runId)
      return { ...run, activeSkills: [...run.activeSkills] }
    },
    listTimeline(sessionId) {
      return getTimeline(sessionId).map(cloneTimeline)
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
      runParentIds.set(run.id, null)
      return { ...record, activeSkills: [...record.activeSkills] }
    },
    createAssistantMessage(message) {
      return createMessage({
        sessionId: message.sessionId,
        runId: message.runId,
        role: "assistant",
        sequence: message.sequence,
      })
    },
    createCompactionMessage(message) {
      return createMessage({
        sessionId: message.sessionId,
        runId: message.runId,
        role: "compaction",
        sequence: message.sequence,
      })
    },
    createMessagePart(part) {
      const message = messages.get(part.messageId)
      if (!message) {
        throw new Error(`Unknown message: ${part.messageId}`)
      }

      const partId = `part-${++partCounter}`
      const storedPart: TimelinePart = {
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
      const run = ensureRun(update.runId)
      Object.assign(run, {
        inputTokens: update.inputTokens,
        outputTokens: update.outputTokens,
        tokenUsageSource: update.tokenUsageSource,
      })
      return { ...run, activeSkills: [...run.activeSkills] }
    },
    transitionRunToRunning(runId) {
      const run = ensureRun(runId)
      run.status = "running"
      return { ...run, activeSkills: [...run.activeSkills] }
    },
    completeRun(runId) {
      const run = ensureRun(runId)
      run.status = "completed"
      return { ...run, activeSkills: [...run.activeSkills] }
    },
    failRun({ runId }) {
      const run = ensureRun(runId)
      run.status = "failed"
      return { ...run, activeSkills: [...run.activeSkills] }
    },
    cancelRun(runId) {
      const run = ensureRun(runId)
      run.status = "cancelled"
      return { ...run, activeSkills: [...run.activeSkills] }
    },
    setSession({ sessionId, activeSkills }) {
      sessions.set(sessionId, {
        id: sessionId,
        workspaceRoot: "/workspace",
        activeSkills: [...(activeSkills ?? [])],
      })
      getTimeline(sessionId)
    },
    setRunParentRunId({ runId, parentRunId }) {
      ensureRun(runId)
      runParentIds.set(runId, parentRunId)
    },
    seedTimelineMessage({ sessionId, runId, role, sequence, parts: messageParts }) {
      getTimeline(sessionId).push({
        runId,
        role,
        sequence,
        parts: messageParts.map((part) => ({ ...part })),
      })
    },
  }
}

async function createWorkspaceRoot() {
  const directory = await mkdtemp(join(tmpdir(), "neo-coworker-subagent-result-size-"))
  tempDirectories.push(directory)
  return directory
}

async function withDeterministicSubRunId<T>(id: string, callback: () => Promise<T>) {
  const original = crypto.randomUUID
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => id,
  })

  try {
    return await callback()
  } finally {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: original,
    })
  }
}

function readMetadata(data: unknown) {
  if (!data || typeof data !== "object" || !("metadata" in data)) {
    return {} as Record<string, unknown>
  }

  const metadata = (data as { metadata?: unknown }).metadata
  return metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {}
}

function readRequiredString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string`)
  }

  return value
}
