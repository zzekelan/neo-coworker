import { describe, expect, test } from "bun:test"
import {
  createSubAgentContext,
  createSubAgentRun,
  type CreateSubAgentRunInput,
} from "../../src/agent"

type SessionPort = CreateSubAgentRunInput["session"]
type SessionPortStub = SessionPort & {
  setSession(input: { sessionId: string; activeSkills?: string[]; parentSessionId?: string }): void
  setRunParentRunId(input: { runId: string; parentRunId: string | null }): void
  getSessionParentSessionId(sessionId: string): string | null
  getRunParentRunId(runId: string): string | null
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

function cloneTimelineMessage(message: TimelineMessage): TimelineMessage {
  return {
    ...message,
    parts: message.parts.map((part) => ({ ...part })),
  }
}

function cloneTimelineParts(parts: TimelinePart[]): TimelinePart[] {
  return parts.map((part) => ({ ...part }))
}

function createSessionPortStub(input: {
  sessionId: string
  timeline?: TimelineMessage[]
  activeSkills?: string[]
}): SessionPortStub {
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
  const timelines = new Map<string, TimelineMessage[]>([
    [input.sessionId, (input.timeline ?? []).map(cloneTimelineMessage)],
  ])
  const sessionParentIds = new Map<string, string | null>([[input.sessionId, null]])
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

  const mutateRun = (runId: string, update: Partial<RunRecord>) => {
    const run = ensureRun(runId)
    Object.assign(run, update)
    return cloneRunRecord(run)
  }

  const createMessage = (inputMessage: {
    sessionId: string
    runId: string
    role: TimelineMessage["role"]
    sequence: number
  }) => {
    const messageId = `message-${++messageCounter}`
    const message: TimelineMessage = {
      runId: inputMessage.runId,
      role: inputMessage.role,
      sequence: inputMessage.sequence,
      parts: [],
    }
    getTimeline(inputMessage.sessionId).push(message)
    messages.set(messageId, message)
    return { id: messageId }
  }

  const port: SessionPortStub = {
    storageIdentity: "session-port-stub",
    getSession(sessionId) {
      return cloneSessionRecord(getSessionRecord(sessionId))
    },
    getRun(runId) {
      return cloneRunRecord(ensureRun(runId))
    },
    listTimeline(sessionId) {
      return getTimeline(sessionId).map(cloneTimelineMessage)
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
    setSession({ sessionId, activeSkills, parentSessionId }) {
      sessions.set(sessionId, {
        id: sessionId,
        workspaceRoot: "/workspace",
        activeSkills: [...(activeSkills ?? [])],
      })
      sessionParentIds.set(sessionId, parentSessionId ?? null)
      getTimeline(sessionId)
    },
    setRunParentRunId({ runId, parentRunId }) {
      ensureRun(runId)
      runParentIds.set(runId, parentRunId)
    },
    getSessionParentSessionId(sessionId) {
      return sessionParentIds.get(sessionId) ?? null
    },
    getRunParentRunId(runId) {
      ensureRun(runId)
      return runParentIds.get(runId) ?? null
    },
    seedTimelineMessage({ sessionId, runId, role, sequence, parts: messageParts }) {
      getTimeline(sessionId).push({
        runId,
        role,
        sequence,
        parts: cloneTimelineParts(messageParts),
      })
    },
  }

  return port
}

function createSubAgentRunInput(overrides: Partial<CreateSubAgentRunInput> = {}): CreateSubAgentRunInput {
  return {
    profile: {
      name: "explore",
      tools: ["read"],
      skills: [],
    },
    prompt: "Inspect the timeline",
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
    createQueuedRun() {
      return { subSessionId: "sub-session-default" }
    },
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
  test("emits the default maxTurns when the profile omits an override", async () => {
    const events: Array<Record<string, unknown>> = []

    await createSubAgentRun(
      createSubAgentRunInput({
        runtimeObserver: {
          recordRuntimeEvent(input) {
            events.push(input.event as Record<string, unknown>)
          },
        },
      }),
    )

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent.started",
        maxTurns: 50,
      }),
    )
  })

  test("emits the explicit profile maxTurns override", async () => {
    const events: Array<Record<string, unknown>> = []

    await createSubAgentRun(
      createSubAgentRunInput({
        profile: {
          name: "explore",
          tools: ["read"],
          skills: [],
          maxTurns: 7,
        },
        runtimeObserver: {
          recordRuntimeEvent(input) {
            events.push(input.event as Record<string, unknown>)
          },
        },
      }),
    )

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent.started",
        maxTurns: 7,
      }),
    )
  })

  test("passes filtered subagent tool guidance into the system prompt builder", async () => {
    let observedGuidances: Parameters<CreateSubAgentRunInput["buildAgentAwarePrompt"]>[1]

    await createSubAgentRun(
      createSubAgentRunInput({
        profile: {
          name: "source-researcher",
          tools: ["read"],
          skills: [],
        },
        parentTools: {
          list() {
            return [
              {
                name: "read",
                description: "Read files",
                concurrency: "read-only" as const,
                usageGuidance: "Use offset and limit for source excerpts.",
              },
              {
                name: "shell",
                description: "Run shell commands",
                concurrency: "mutating" as const,
                usageGuidance: "Run shell commands.",
              },
            ]
          },
          async execute() {
            throw new Error("parent tools should not execute in this test")
          },
          async executeBatch() {
            return []
          },
        },
        buildAgentAwarePrompt(_profile, toolGuidances) {
          observedGuidances = toolGuidances
          return "system prompt"
        },
      }),
    )

    expect(observedGuidances).toEqual([
      {
        name: "read",
        guidance: "Use offset and limit for source excerpts.",
        isReadOnly: true,
      },
    ])
  })

  test("inherits parent activeSkills when profile.skills is empty", async () => {
    const session = createSessionPortStub({
      sessionId: "session-parent",
      activeSkills: ["review", "explore"],
    })
    const subSessionId = "sub-session-inherited-skills"
    let queuedActiveSkills: string[] = []
    let subRunId = ""

    await createSubAgentRun(
      createSubAgentRunInput({
        session,
        sessionId: "session-parent",
        profile: {
          name: "explore",
          tools: ["read"],
          skills: [],
        },
        createQueuedRun({ subRunId: queuedRunId, prompt, activeSkills, createdAt }) {
          queuedActiveSkills = [...activeSkills]
          subRunId = queuedRunId
          session.setSession({ sessionId: subSessionId, activeSkills })
          session.createRun({
            id: queuedRunId,
            sessionId: subSessionId,
            trigger: "summarize",
            status: "queued",
            createdAt,
            activeSkills,
          })
          session.seedTimelineMessage({
            sessionId: subSessionId,
            runId: queuedRunId,
            role: "user",
            sequence: 0,
            parts: [{ kind: "text", text: prompt }],
          })

          return { subSessionId }
        },
      }),
    )

    expect(queuedActiveSkills).toEqual(["review", "explore"])
    expect(session.getSession(subSessionId).activeSkills).toEqual(["review", "explore"])
    expect(session.getRun(subRunId).activeSkills).toEqual(["review", "explore"])
  })

  test("records context usage events against the subsession sessionId", async () => {
    const session = createSessionPortStub({
      sessionId: "session-parent",
    })
    const subSessionId = "sub-session-usage"
    const observed: Array<{
      sessionId: string
      runId: string
      event: Record<string, unknown>
    }> = []

    await createSubAgentRun(
      createSubAgentRunInput({
        session,
        runtimeObserver: {
          recordRuntimeEvent(input) {
            observed.push({
              sessionId: input.sessionId,
              runId: input.runId,
              event: input.event as Record<string, unknown>,
            })
          },
        },
        createQueuedRun({ subRunId, prompt, activeSkills, createdAt }) {
          session.setSession({ sessionId: subSessionId, activeSkills })
          session.createRun({
            id: subRunId,
            sessionId: subSessionId,
            trigger: "summarize",
            status: "queued",
            createdAt,
            activeSkills,
          })
          session.seedTimelineMessage({
            sessionId: subSessionId,
            runId: subRunId,
            role: "user",
            sequence: 0,
            parts: [{ kind: "text", text: prompt }],
          })

          return { subSessionId }
        },
        createStepService({ runtimeObserver }) {
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
              const usageEvent = {
                type: "context.usage.updated",
                sessionId: stepInput.sessionId,
                runId: stepInput.runId,
                contextTokens: 42,
                contextWindow: 100,
                utilizationPercent: 42,
                source: "provider",
              } satisfies Record<string, unknown>

              stepInput.emit(usageEvent)
              runtimeObserver?.recordRuntimeEvent?.({
                sessionId: stepInput.sessionId,
                runId: stepInput.runId,
                event: usageEvent,
              })

              return { status: "complete" }
            },
          }
        },
      }),
    )

    const usageEvents = observed.filter((event) => event.event.type === "context.usage.updated")

    expect(usageEvents).toHaveLength(2)
    expect(usageEvents).toEqual([
      expect.objectContaining({
        sessionId: subSessionId,
        event: expect.objectContaining({ sessionId: subSessionId }),
      }),
      expect.objectContaining({
        sessionId: subSessionId,
        event: expect.objectContaining({ sessionId: subSessionId }),
      }),
    ])
    expect(usageEvents.every((event) => event.sessionId !== "session-parent")).toBe(true)
  })

  test("cancels the child SubSession run when the parent signal aborts", async () => {
    const session = createSessionPortStub({
      sessionId: "session-parent",
    })
    const parent = new AbortController()
    const subSessionId = "sub-session-abort"
    let queuedRunId = ""
    let executedSessionId = ""
    let resolveExecuteStepStarted: (() => void) | undefined
    const executeStepStarted = new Promise<void>((resolve) => {
      resolveExecuteStepStarted = resolve
    })

    const runPromise = createSubAgentRun(
      createSubAgentRunInput({
        session,
        sessionId: "session-parent",
        signal: parent.signal,
        createQueuedRun({ subRunId, prompt, activeSkills, createdAt, parentRunId }) {
          queuedRunId = subRunId
          session.setSession({
            sessionId: subSessionId,
            activeSkills,
            parentSessionId: "session-parent",
          })
          session.createRun({
            id: subRunId,
            sessionId: subSessionId,
            trigger: "summarize",
            status: "queued",
            createdAt,
            activeSkills,
          })
          session.setRunParentRunId({ runId: subRunId, parentRunId })
          session.seedTimelineMessage({
            sessionId: subSessionId,
            runId: subRunId,
            role: "user",
            sequence: 0,
            parts: [{ kind: "text", text: prompt }],
          })

          return { subSessionId }
        },
        createStepService({ session }) {
          return {
            isAbortError(error) {
              return error instanceof Error && error.name === "AbortError"
            },
            isDetachedError() {
              return false
            },
            initializeRun({ runId }) {
              session.transitionRunToRunning(runId)
            },
            completeRun() {},
            failRun() {},
            cancelRun({ runId }) {
              session.cancelRun(runId)
              return true
            },
            async executeStep(stepInput) {
              executedSessionId = stepInput.sessionId
              await new Promise<void>((resolve) => {
                if (stepInput.signal.aborted) {
                  resolveExecuteStepStarted?.()
                  resolve()
                  return
                }

                stepInput.signal.addEventListener("abort", () => resolve(), { once: true })
                resolveExecuteStepStarted?.()
              })

              expect(stepInput.signal.aborted).toBe(true)
              return { status: "cancelled" }
            },
          }
        },
      }),
    )

    await executeStepStarted

    expect(session.getSessionParentSessionId(subSessionId)).toBe("session-parent")
    expect(session.getRun(queuedRunId)).toMatchObject({
      sessionId: subSessionId,
      status: "running",
    })

    parent.abort("stop-child")

    await expect(runPromise).rejects.toMatchObject({
      name: "AbortError",
      message: "Sub-agent run cancelled",
    })

    expect(executedSessionId).toBe(subSessionId)
    expect(session.getRun(queuedRunId)).toMatchObject({
      sessionId: subSessionId,
      status: "cancelled",
    })
  })

  test("scoped sub-agent timeline only includes its own run and still returns final assistant output", async () => {
    const session = createSessionPortStub({
      sessionId: "session-1",
    })
    const subSessionId = "sub-session-1"
    let scopedTimelineBeforeWrite: TimelineMessage[] = []
    let scopedTimelineAfterWrite: TimelineMessage[] = []

    const output = await createSubAgentRun(
      createSubAgentRunInput({
        session,
        createQueuedRun({ subRunId, prompt, activeSkills, createdAt }) {
          session.setSession({ sessionId: subSessionId, activeSkills })
          session.createRun({
            id: subRunId,
            sessionId: subSessionId,
            trigger: "summarize",
            status: "queued",
            createdAt,
            activeSkills,
          })
          session.seedTimelineMessage({
            sessionId: subSessionId,
            runId: subRunId,
            role: "user",
            sequence: 0,
            parts: [{ kind: "text", text: prompt }],
          })

          return { subSessionId }
        },
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
              scopedTimelineBeforeWrite = session.listTimeline(stepInput.sessionId)

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

              scopedTimelineAfterWrite = session.listTimeline(stepInput.sessionId)

              return { status: "complete" }
            },
          }
        },
      }),
    )

    expect(scopedTimelineBeforeWrite).toEqual([
      {
        runId: scopedTimelineAfterWrite[0]!.runId,
        role: "user",
        sequence: 0,
        parts: [{ kind: "text", text: "Inspect the timeline" }],
      },
    ])
    expect(scopedTimelineAfterWrite).toHaveLength(2)
    expect(scopedTimelineAfterWrite.map((message) => message.runId)).toEqual([
      scopedTimelineAfterWrite[0]!.runId,
      scopedTimelineAfterWrite[0]!.runId,
    ])
    expect(scopedTimelineAfterWrite.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(scopedTimelineAfterWrite[1]?.parts[0]?.text).toBe("child-only output")
    expect(output).toBe("child-only output")

    const parentVisibleTimeline = session.listTimeline("session-1")
    expect(parentVisibleTimeline).toEqual([])
    expect(session.listTimeline(subSessionId)).toEqual([
      {
        runId: scopedTimelineAfterWrite[0]!.runId,
        role: "user",
        sequence: 0,
        parts: [{ kind: "text", text: "Inspect the timeline" }],
      },
      {
        runId: scopedTimelineAfterWrite[0]!.runId,
        role: "assistant",
        sequence: 2,
        parts: [{ kind: "text", text: "child-only output" }],
      },
    ])
  })

  test("createSubAgentRun creates a new SubSession that receives the child run instead of parent-session writes", async () => {
    const session = createSessionPortStub({
      sessionId: "session-1",
      timeline: [
        {
          runId: "parent-run",
          role: "assistant",
          sequence: 0,
          parts: [{ kind: "text", text: "parent answer" }],
        },
      ],
    })
    const subSessionId = "test-sub-session"
    let queuedRunId = ""
    let executedSessionId = ""
    let executedRunId = ""

    await createSubAgentRun(
      createSubAgentRunInput({
        session,
        createQueuedRun({ subRunId, prompt, activeSkills, createdAt, parentRunId }) {
          queuedRunId = subRunId
          session.setSession({
            sessionId: subSessionId,
            activeSkills,
            parentSessionId: "session-1",
          })
          session.createRun({
            id: subRunId,
            sessionId: subSessionId,
            trigger: "summarize",
            status: "queued",
            createdAt,
            activeSkills,
          })
          session.setRunParentRunId({ runId: subRunId, parentRunId })
          session.seedTimelineMessage({
            sessionId: subSessionId,
            runId: subRunId,
            role: "user",
            sequence: 0,
            parts: [{ kind: "text", text: prompt }],
          })

          return { subSessionId }
        },
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
              executedSessionId = stepInput.sessionId
              executedRunId = stepInput.runId
              const assistantMessage = session.createAssistantMessage({
                sessionId: stepInput.sessionId,
                runId: stepInput.runId,
                sequence: 1,
                createdAt: 2,
              })
              session.createMessagePart({
                sessionId: stepInput.sessionId,
                runId: stepInput.runId,
                messageId: assistantMessage.id,
                kind: "text",
                sequence: 0,
                text: "isolated output",
                createdAt: 2,
              })

              return { status: "complete" }
            },
          }
        },
      }),
    )

    expect(session.getSessionParentSessionId(subSessionId)).toBe("session-1")
    expect(session.getRun(queuedRunId).sessionId).toBe(subSessionId)
    expect(executedSessionId).toBe(subSessionId)
    expect(executedRunId).toBe(queuedRunId)
    expect(session.listTimeline("session-1")).toEqual([
      {
        runId: "parent-run",
        role: "assistant",
        sequence: 0,
        parts: [{ kind: "text", text: "parent answer" }],
      },
    ])
    expect(session.listTimeline(subSessionId)).toEqual([
      {
        runId: expect.stringMatching(/^run_/),
        role: "user",
        sequence: 0,
        parts: [{ kind: "text", text: "Inspect the timeline" }],
      },
      {
        runId: expect.stringMatching(/^run_/),
        role: "assistant",
        sequence: 1,
        parts: [{ kind: "text", text: "isolated output" }],
      },
    ])
  })

  test("createSubAgentRun preserves parentRunId on the child SubSession run for backward compatibility", async () => {
    const session = createSessionPortStub({
      sessionId: "session-1",
    })
    const subSessionId = "test-sub-session-backward-compat"
    let queuedRunId = ""

    await createSubAgentRun(
      createSubAgentRunInput({
        session,
        parentRunId: "parent-run-task-8",
        createQueuedRun({ subRunId, prompt, activeSkills, createdAt, parentRunId }) {
          queuedRunId = subRunId
          session.setSession({
            sessionId: subSessionId,
            activeSkills,
            parentSessionId: "session-1",
          })
          session.createRun({
            id: subRunId,
            sessionId: subSessionId,
            trigger: "summarize",
            status: "queued",
            createdAt,
            activeSkills,
          })
          session.setRunParentRunId({ runId: subRunId, parentRunId })
          session.seedTimelineMessage({
            sessionId: subSessionId,
            runId: subRunId,
            role: "user",
            sequence: 0,
            parts: [{ kind: "text", text: prompt }],
          })

          return { subSessionId }
        },
      }),
    )

    expect(session.getRun(queuedRunId).sessionId).toBe(subSessionId)
    expect(session.getRunParentRunId(queuedRunId)).toBe("parent-run-task-8")
  })
})
