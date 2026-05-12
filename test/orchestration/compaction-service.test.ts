import { describe, expect, test } from "bun:test"
import type {
  OrchestrationModelPort,
  OrchestrationPartRecord,
  OrchestrationRunRecord,
  OrchestrationSessionPort,
  OrchestrationTimelineMessage,
} from "../../src/orchestration"
import {
  COMPACTION_HANDOFF_FRAMING,
  COMPACTION_TAIL_HEADING,
  createOrchestrationCompactionService,
  selectTailMessagesByTokenBudget,
} from "../../src/orchestration/application/compaction-service"
import { createRecentFileTracker } from "../../src/orchestration/application/recent-file-tracker"
import { createSkillReminderTracker } from "../../src/orchestration/application/skill-reminder-tracker"

describe("orchestration compaction service", () => {
  test("first compaction uses the standard summary prompt and prepends handoff framing", async () => {
    const harness = createHarness({
      summaryTexts: [buildStructuredSummary("alpha")],
      timeline: [
        makeTextMessage("run_history", "user", 0, "Initial request"),
        makeTextMessage("run_history", "assistant", 1, "Reviewed architecture details."),
        makeTextMessage("run_history", "user", 2, "Keep the extraction focused."),
      ],
    })

    const result = await harness.service.compactSession(createManualCompactionInput(harness.session, "run_manual_1"))

    expect(result).toEqual({ status: "completed" })
    expect(readSummaryPrompt(harness.modelCapture.summaryRequests[0])).not.toContain(
      "Previous compaction summary:",
    )

    const summaryText = readLatestSummaryText(harness.session.timeline)
    expect(summaryText).toStartWith(COMPACTION_HANDOFF_FRAMING)
    expect(summaryText).toContain("Solve alpha")
    expect(summaryText).toContain(COMPACTION_TAIL_HEADING)
  })

  test("second compaction includes the previous summary in the iterative prompt", async () => {
    const harness = createHarness({
      summaryTexts: [buildStructuredSummary("alpha"), buildStructuredSummary("beta")],
      timeline: [
        makeTextMessage("run_history", "user", 0, "Initial request"),
        makeTextMessage("run_history", "assistant", 1, "Reviewed architecture details."),
        makeTextMessage("run_history", "user", 2, "Keep the extraction focused."),
      ],
    })

    await harness.service.compactSession(createManualCompactionInput(harness.session, "run_manual_1"))
    harness.session.appendMessage(makeTextMessage("run_followup", "user", 3, "Continue with the beta cleanup."))
    harness.session.appendMessage(makeTextMessage("run_followup", "assistant", 4, "Working on the extracted service."))
    harness.session.addRun("run_manual_2")

    const result = await harness.service.compactSession(createManualCompactionInput(harness.session, "run_manual_2"))

    expect(result).toEqual({ status: "completed" })
    expect(readSummaryPrompt(harness.modelCapture.summaryRequests[1])).toContain(
      "Previous compaction summary:",
    )
    expect(readSummaryPrompt(harness.modelCapture.summaryRequests[1])).toContain("Solve alpha")
  })

  test("tail protection is token-budget based instead of fixed-message based", () => {
    const timeline = [
      makeTextMessage("run_history", "user", 0, "short one"),
      makeTextMessage("run_history", "assistant", 1, "short two"),
      makeTextMessage("run_history", "user", 2, "x".repeat(500)),
      makeTextMessage("run_history", "assistant", 3, "tail"),
    ]

    const narrowTail = selectTailMessagesByTokenBudget({
      timeline,
      tailTokenBudget: 40,
    })
    const wideTail = selectTailMessagesByTokenBudget({
      timeline,
      tailTokenBudget: 200,
    })

    expect(narrowTail.map((message) => message.sequence)).toEqual([3])
    expect(wideTail.map((message) => message.sequence)).toEqual([1, 2, 3])
  })

  test("compaction emits trigger, summary, and handoff telemetry", async () => {
    const harness = createHarness({
      summaryTexts: [buildStructuredSummary("alpha")],
      timeline: [
        makeTextMessage("run_history", "user", 0, "Initial request"),
        makeTextMessage("run_history", "assistant", 1, "Reviewed architecture details."),
        makeTextMessage("run_history", "user", 2, "Keep the extraction focused."),
      ],
    })

    await harness.service.compactSession(createManualCompactionInput(harness.session, "run_manual_1"))

    const compactionEvents = harness.observedEvents
      .map((entry) => entry.event)
      .filter((event) => event.type.startsWith("compaction."))

    expect(compactionEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "compaction.triggered",
          reason: "manual",
          estimatedTokens: 800,
        }),
        expect.objectContaining({
          type: "compaction.summary_generated",
          summaryLength: buildStructuredSummary("alpha").length,
          sectionsIncluded: expect.arrayContaining(["Primary Request", "Next Steps"]),
        }),
        expect.objectContaining({
          type: "compaction.handoff_framing",
          framingLength: COMPACTION_HANDOFF_FRAMING.length,
        }),
      ]),
    )
  })

  test("iterative compaction emits merge telemetry", async () => {
    const harness = createHarness({
      summaryTexts: [buildStructuredSummary("alpha"), buildStructuredSummary("beta")],
      timeline: [
        makeTextMessage("run_history", "user", 0, "Initial request"),
        makeTextMessage("run_history", "assistant", 1, "Reviewed architecture details."),
        makeTextMessage("run_history", "user", 2, "Keep the extraction focused."),
      ],
    })

    await harness.service.compactSession(createManualCompactionInput(harness.session, "run_manual_1"))
    harness.session.appendMessage(makeTextMessage("run_followup", "user", 3, "Continue with the beta cleanup."))
    harness.session.appendMessage(makeTextMessage("run_followup", "assistant", 4, "Working on the extracted service."))
    harness.session.addRun("run_manual_2")

    await harness.service.compactSession(createManualCompactionInput(harness.session, "run_manual_2"))

    const iterativeEvent = harness.observedEvents
      .map((entry) => entry.event)
      .find((event) => event.type === "compaction.iterative_merge")

    expect(iterativeEvent).toEqual(
      expect.objectContaining({
        type: "compaction.iterative_merge",
        previousSummaryLength: expect.any(Number),
        newSummaryLength: buildStructuredSummary("beta").length,
      }),
    )
  })

  test("iterative prompt strips prior handoff framing and preserved tail text before reuse", async () => {
    const harness = createHarness({
      summaryTexts: [buildStructuredSummary("alpha"), buildStructuredSummary("beta")],
      timeline: [
        makeTextMessage("run_history", "user", 0, "Initial request"),
        makeTextMessage("run_history", "assistant", 1, "Reviewed architecture details."),
        makeToolCallMessage("run_history", 2, "read", '{"path":"README.md"}'),
        makeToolResultMessage("run_history", 3, "read", "README excerpt"),
      ],
    })

    await harness.service.compactSession(createManualCompactionInput(harness.session, "run_manual_1"))
    harness.session.appendMessage(makeTextMessage("run_followup", "user", 4, "Continue with the beta cleanup."))
    harness.session.addRun("run_manual_2")

    await harness.service.compactSession(createManualCompactionInput(harness.session, "run_manual_2"))

    const iterativePrompt = readSummaryPrompt(harness.modelCapture.summaryRequests[1])
    const previousSummarySection = iterativePrompt
      .split("Previous compaction summary:\n")[1]
      ?.split("\n\nSummarize the conversation so the next model turn can continue the same work after context compaction.")[0]

    expect(previousSummarySection).toBeDefined()
    expect(previousSummarySection).toContain("Solve alpha")
    expect(previousSummarySection).not.toContain(COMPACTION_HANDOFF_FRAMING)
    expect(previousSummarySection).not.toContain(COMPACTION_TAIL_HEADING)
    expect(previousSummarySection).not.toContain("[tool_result:read] README excerpt")
  })

  test("compaction ignores reasoning deltas emitted during summarization", async () => {
    const harness = createHarness({
      summaryTexts: [buildStructuredSummary("gamma")],
      timeline: [
        makeTextMessage("run_history", "user", 0, "Initial request"),
        makeTextMessage("run_history", "assistant", 1, "Thinking through the compact summary."),
      ],
    })
    harness.modelCapture.streamEvents = [
      { type: "reasoning.delta", text: "first reason about the summary" },
      { type: "text.delta", text: buildStructuredSummary("gamma") },
      {
        type: "usage",
        inputTokens: 120,
        outputTokens: 24,
        source: "estimated",
      },
    ]

    const result = await harness.service.compactSession(createManualCompactionInput(harness.session, "run_manual_1"))

    expect(result).toEqual({ status: "completed" })
    expect(readLatestSummaryText(harness.session.timeline)).toContain("Solve gamma")
  })

  test("auto compaction reads Produced By Run provenance on timeline entries", async () => {
    const harness = createHarness({
      summaryTexts: [buildStructuredSummary("timeline")],
      timeline: [
        makeTimelineTextEntry("run_active", "assistant", 0, 0, "Current run content only."),
      ],
    })
    harness.session.addRun("run_active")

    const result = await harness.service.maybeAutoCompact({
      contextWindow: 20_000,
      sessionId: harness.session.sessionId,
      runId: "run_active",
      run: harness.session.getRun("run_active"),
      systemPrompt: "system",
      workspaceRoot: "/workspace",
      skillCatalog: [],
      tools: [],
      timeline: harness.session.timeline,
      signal: new AbortController().signal,
      emit() {},
    })

    expect(result).toEqual({ compacted: false })
    expect(harness.modelCapture.projectRequests).toHaveLength(0)
  })
})

function createHarness(input: {
  summaryTexts: string[]
  timeline: OrchestrationTimelineMessage[]
}) {
  const skillReminders = createSkillReminderTracker()
  const recentFiles = createRecentFileTracker()
  const session = createMemorySession({ timeline: input.timeline })
  const modelCapture = createCompactionModelCapture(input.summaryTexts)
  const observedEvents: Array<{
    sessionId: string
    runId: string
    event: { type: string; [key: string]: unknown }
  }> = []

  const service = createOrchestrationCompactionService({
    session,
    model: modelCapture.model,
    runtimeObserver: {
      recordRuntimeEvent(event) {
        observedEvents.push({
          sessionId: event.sessionId,
          runId: event.runId,
          event: event.event,
        })
      },
    },
    skillReminders,
    recentFiles,
    buildLateContextMessage({ workspaceRoot, activeSkillNames, systemReminders }) {
      return JSON.stringify({ workspaceRoot, activeSkillNames, systemReminders })
    },
    async recoverActiveSkills({ sessionId, activeSkillNames }) {
      skillReminders.injectActiveSkills({
        sessionId,
        skills: activeSkillNames.map((name) => ({
          name,
          path: `.ncoworker/skills/${name}/SKILL.md`,
          instructions: `Recovered instructions for ${name}`,
        })),
        reason: "recovery",
      })
    },
    now: createMonotonicClock(),
  })

  return {
    service,
    session,
    modelCapture,
    observedEvents,
  }
}

function createCompactionModelCapture(summaryTexts: string[]) {
  const summaryRequests: Array<Parameters<OrchestrationModelPort["streamTurn"]>[0]> = []
  const projectRequests: Array<Parameters<NonNullable<OrchestrationModelPort["projectTurn"]>>[0]> = []
  const projectedTokens = [800, 240, 760, 220]
  let projectIndex = 0
  const capture = {
    streamEvents: null as Array<
      | { type: "text.delta"; text: string }
      | { type: "reasoning.delta"; text: string }
      | { type: "usage"; inputTokens: number; outputTokens: number; source: "provider" | "estimated" }
    > | null,
  }

  const model: OrchestrationModelPort = {
    projectTurn(request) {
      projectRequests.push(request)
      const inputTokens = projectedTokens[Math.min(projectIndex, projectedTokens.length - 1)] ?? 600
      projectIndex += 1
      return { inputTokens }
    },
    async *streamTurn(request) {
      summaryRequests.push(request)
      if (capture.streamEvents) {
        for (const event of capture.streamEvents) {
          yield event
        }
        return
      }

      const summaryText = summaryTexts[Math.max(0, summaryRequests.length - 1)] ?? summaryTexts.at(-1) ?? ""
      yield { type: "text.delta" as const, text: summaryText }
      yield {
        type: "usage" as const,
        inputTokens: 120,
        outputTokens: 24,
        source: "estimated" as const,
      }
    },
  }

  return {
    model,
    summaryRequests,
    projectRequests,
    ...capture,
  }
}

function createManualCompactionInput(
  session: ReturnType<typeof createMemorySession>,
  runId: string,
) {
  return {
    contextWindow: 600,
    sessionId: session.sessionId,
    runId,
    systemPrompt: "system",
    workspaceRoot: "/workspace",
    skillCatalog: [],
    tools: [],
    signal: new AbortController().signal,
    emit() {},
  }
}

function readSummaryPrompt(request: Parameters<OrchestrationModelPort["streamTurn"]>[0] | undefined) {
  const promptMessage = request?.timeline.at(-1)
  const promptPart = promptMessage?.parts.find((part) => part.kind === "text")
  return promptPart?.text ?? ""
}

function readLatestSummaryText(timeline: OrchestrationTimelineMessage[]) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const message = timeline[index]
    if (message?.role !== "compaction") {
      continue
    }

    const part = message.parts.find((item) => item.kind === "text")
    if (part?.text) {
      return part.text
    }
  }

  throw new Error("Expected a compaction summary message")
}

function buildStructuredSummary(label: string) {
  return [
    "Primary Request",
    `Solve ${label}`,
    "",
    "Key Concepts",
    `${label} concepts`,
    "",
    "Files & Code",
    `${label}.ts`,
    "",
    "Errors & Fixes",
    `No ${label} errors`,
    "",
    "Problem Solving",
    `Remember ${label} detail`,
    "",
    "User Messages",
    `${label} user ask`,
    "",
    "Pending Tasks",
    `Finish ${label}`,
    "",
    "Current Work",
    `Working on ${label}`,
    "",
    "Next Steps",
    `Wrap up ${label}`,
  ].join("\n")
}

function makeTextMessage(
  runId: string,
  role: OrchestrationTimelineMessage["role"],
  sequence: number,
  text: string,
): OrchestrationTimelineMessage {
  return {
    runId,
    role,
    sequence,
    parts: [{ kind: "text", text }],
  }
}

function makeTimelineTextEntry(
  producedByRunId: string,
  role: OrchestrationTimelineMessage["role"],
  runSequence: number,
  timelineSequence: number,
  text: string,
): OrchestrationTimelineMessage {
  return {
    producedByRunId,
    role,
    runSequence,
    timelineSequence,
    parts: [{ kind: "text", text }],
  } as unknown as OrchestrationTimelineMessage
}

function makeToolCallMessage(
  runId: string,
  sequence: number,
  toolName: string,
  inputText: string,
): OrchestrationTimelineMessage {
  return {
    runId,
    role: "assistant",
    sequence,
    parts: [
      {
        kind: "tool_call",
        text: inputText,
        data: {
          toolName,
          inputText,
        },
      },
    ],
  }
}

function makeToolResultMessage(
  runId: string,
  sequence: number,
  toolName: string,
  output: string,
): OrchestrationTimelineMessage {
  return {
    runId,
    role: "assistant",
    sequence,
    parts: [
      {
        kind: "tool_result",
        text: output,
        data: {
          toolName,
          output,
        },
      },
    ],
  }
}

function createMemorySession(input: { timeline: OrchestrationTimelineMessage[] }) {
  const sessionId = "session_compaction"
  let nextMessageId = 0
  let nextPartId = 0
  const timeline = [...input.timeline]
  const messageIds = new Map<string, OrchestrationTimelineMessage>()
  const partIds = new Map<string, OrchestrationPartRecord>()
  const runs = new Map<string, OrchestrationRunRecord>()

  const baseRunIds = ["run_manual_1"]
  for (const runId of baseRunIds) {
    runs.set(runId, {
      id: runId,
      sessionId,
      createdAt: 1,
      status: "running",
      activeSkills: [],
      inputTokens: 0,
      outputTokens: 0,
      tokenUsageSource: null,
    })
  }

  const session: OrchestrationSessionPort & {
    sessionId: string
    timeline: OrchestrationTimelineMessage[]
    addRun(runId: string): void
    appendMessage(message: OrchestrationTimelineMessage): void
  } = {
    sessionId,
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
    addRun(runId: string) {
      runs.set(runId, {
        id: runId,
        sessionId,
        createdAt: timeline.length + 1,
        status: "running",
        activeSkills: [],
        inputTokens: 0,
        outputTokens: 0,
        tokenUsageSource: null,
      })
    },
    appendMessage(message: OrchestrationTimelineMessage) {
      timeline.push(message)
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
