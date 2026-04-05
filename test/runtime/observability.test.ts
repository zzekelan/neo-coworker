import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createObservabilityRepository,
  createObservabilityRuntimeApi,
  type StoredRunEvent,
} from "../../src/observability"
import {
  createSessionRepository,
  createSessionRunService,
  openSessionDatabase,
  type SessionRepository,
} from "../../src/session"
import { createPermissionRepository, type PermissionRepository } from "../../src/permission"
import {
  createModelProvider,
  createModelRuntimeApi,
  type ProviderEvent,
  type ProviderTurnRequest,
} from "../../src/model"
import { createRuntime } from "../../src/bootstrap"

const tempDirectories: string[] = []
const openDatabases: Database[] = []

afterEach(async () => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("runtime observability", () => {
  test("persists runtime, model, and tool events as a durable trace", async () => {
    const harness = await createHarness("trace-complete", true)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_complete",
      messageId: "message_trace_complete",
      prompt: "Read README.md and summarize it",
    })
    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* () {
            yield {
              type: "tool.call",
              callId: "call_read",
              name: "read",
              inputText: '{"path":"README.md"}',
            }
          },
          async function* () {
            yield { type: "text.delta", text: "Summary complete." }
          },
        ],
        harness.observability.modelObserver,
      ),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    expect(readEventTypes(harness.observabilityRepository.runEvents.listByRun(started.run.id))).toEqual([
      "run.started",
      "skill.run.snapshot.applied",
      "tool.listed",
      "model.turn.requested",
      "model.prompt.assembled",
      "message.started",
      "tool.executed",
      "tool.call.completed",
      "model.turn.usage",
      "context.usage.updated",
      "tool.listed",
      "model.turn.requested",
      "model.prompt.assembled",
      "message.started",
      "message.delta",
      "model.turn.usage",
      "context.usage.updated",
      "run.completed",
    ])
  })

  test("persists permission request and reply events for ask-mode tools", async () => {
    const harness = await createHarness("trace-permission", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_permission",
      messageId: "message_trace_permission",
      prompt: "Run pwd",
    })
    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* () {
            yield {
              type: "tool.call",
              callId: "call_shell",
              name: "shell",
              inputText: '{"command":"pwd"}',
            }
          },
          async function* () {
            yield { type: "text.delta", text: "Shell completed." }
          },
        ],
        harness.observability.modelObserver,
      ),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events, {
      onEvent(event) {
        if (
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "permission.requested" &&
          "requestId" in event &&
          typeof event.requestId === "string"
        ) {
          handle.respondPermission({
            requestId: event.requestId,
            decision: "allow",
          })
        }
      },
    })

    expect(readEventTypes(harness.observabilityRepository.runEvents.listByRun(started.run.id))).toContain(
      "permission.requested",
    )
    expect(readEventTypes(harness.observabilityRepository.runEvents.listByRun(started.run.id))).toContain(
      "permission.responded",
    )
  })

  test("exports persisted traces after reopening the same storage file", async () => {
    const harness = await createHarness("trace-reopen", true)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_reopen",
      messageId: "message_trace_reopen",
      prompt: "Read README.md and summarize it",
    })
    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* () {
            yield {
              type: "tool.call",
              callId: "call_read_reopen",
              name: "read",
              inputText: '{"path":"README.md"}',
            }
          },
          async function* () {
            yield { type: "text.delta", text: "Summary after reopen." }
          },
        ],
        harness.observability.modelObserver,
      ),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    const initialTrace = harness.observability.exportRunTrace(started.run.id)
    expect(initialTrace?.events.map((event) => event.eventType)).toEqual([
      "run.started",
      "skill.run.snapshot.applied",
      "tool.listed",
      "model.turn.requested",
      "model.prompt.assembled",
      "message.started",
      "tool.executed",
      "tool.call.completed",
      "model.turn.usage",
      "context.usage.updated",
      "tool.listed",
      "model.turn.requested",
      "model.prompt.assembled",
      "message.started",
      "message.delta",
      "model.turn.usage",
      "context.usage.updated",
      "run.completed",
    ])

    closeTrackedDatabase(harness.database)

    const reopenedDatabase = openSessionDatabase(harness.databasePath)

    try {
      const reopenedRepository = createSessionRepository({
        database: reopenedDatabase,
        now: harness.now,
      })
      const reopenedObservabilityRepository = createObservabilityRepository({
        database: reopenedDatabase,
        now: harness.now,
      })
      const reopenedObservability = createObservabilityRuntimeApi({
        repository: reopenedObservabilityRepository,
        now: harness.now,
      })

      expect(reopenedRepository.runs.get(started.run.id)).toMatchObject({
        status: "completed",
        tokenUsageSource: "estimated",
        inputTokens: expect.any(Number),
      })
      expect(
        reopenedObservability.exportRunTrace(started.run.id)?.events.map((event) => event.eventType),
      ).toEqual(initialTrace?.events.map((event) => event.eventType))
    } finally {
      reopenedDatabase.close(false)
    }
  })

  test("records skill disclosure telemetry before and after activation", async () => {
    const harness = await createHarness("trace-skill", false)
    const skillDirectory = join(harness.session.workspaceRoot, ".agents", "skills", "reviewer")

    await mkdir(skillDirectory, { recursive: true })
    await Bun.write(
      join(skillDirectory, "SKILL.md"),
      [
        "name: reviewer",
        "description: Review code changes carefully",
        "",
        "Focus on bugs first.",
      ].join("\n"),
    )

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_skill",
      messageId: "message_trace_skill",
      prompt: "Use the reviewer skill if needed",
    })
    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* () {
            yield {
              type: "tool.call",
              callId: "call_skill",
              name: "skill",
              inputText: '{"name":"reviewer"}',
            }
          },
          async function* () {
            yield { type: "text.delta", text: "Reviewer ready." }
          },
        ],
        harness.observability.modelObserver,
      ),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    const trace = harness.observability.exportRunTrace(started.run.id)
    expect(trace).not.toBeNull()
    expect(readEventTypes(trace?.events ?? [])).toEqual(
      expect.arrayContaining([
        "skill.run.snapshot.applied",
        "skill.catalog.exposed",
        "skill.load.requested",
        "skill.load.completed",
        "skill.activated",
        "model.prompt.assembled",
      ]),
    )

    const promptEvents = (trace?.events ?? []).filter((event) => event.eventType === "model.prompt.assembled")
    expect(promptEvents).toHaveLength(2)
    expect(promptEvents[0]?.data).toMatchObject({
      catalogSkillNames: ["reviewer"],
      activeSkillNames: [],
      activeSkillCount: 0,
      recoveryFilePaths: [],
      systemPromptLength: expect.any(Number),
      systemReminderLength: expect.any(Number),
    })
    expect(promptEvents[1]?.data).toMatchObject({
      catalogSkillNames: [],
      activeSkillNames: ["reviewer"],
      activeSkillCount: 1,
      recoveryFilePaths: [],
      systemPromptHash: promptEvents[0]?.data.systemPromptHash,
    })
    expect(promptEvents[0]?.data.systemReminderHash).not.toBe(promptEvents[1]?.data.systemReminderHash)

    const activationEvent = trace?.events.find((event) => event.eventType === "skill.activated")
    expect(activationEvent?.data).toMatchObject({
      skillName: "reviewer",
      activeSkillNames: ["reviewer"],
      activeSkillCount: 1,
    })

    const loadCompletedEvents = (trace?.events ?? []).filter(
      (event) => event.eventType === "skill.load.completed",
    )
    const catalogEvents = (trace?.events ?? []).filter((event) => event.eventType === "skill.catalog.exposed")
    expect(catalogEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          catalogSkillNames: ["reviewer"],
          catalogSkillCount: 1,
        }),
      }),
    ])
    expect(loadCompletedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            skillName: "reviewer",
            skillPath: ".agents/skills/reviewer/SKILL.md",
          }),
        }),
      ]),
    )
  })

  test("records compaction lifecycle on the parent run and summarize run traces", async () => {
    const harness = await createHarness("trace-compaction", false)
    seedCompletedRunWithToolResults({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_trace_compaction_history",
      toolName: "shell",
      resultCount: 7,
      output: "shell output\n" + "x".repeat(4_000),
    })

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_compaction",
      messageId: "message_trace_compaction",
      prompt: "Continue after compaction",
    })
    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* () {
            yield {
              type: "text.delta",
              text: [
                "Primary Request",
                "Continue after compaction.",
                "",
                "Key Concepts",
                "Summaries replace earlier transcript chunks.",
                "",
                "Files & Code",
                "README.md",
                "",
                "Errors & Fixes",
                "None.",
                "",
                "Problem Solving",
                "Compact first, then continue.",
                "",
                "User Messages",
                "Continue after compaction",
                "",
                "Pending Tasks",
                "Finish the response.",
                "",
                "Current Work",
                "Replying after compaction.",
                "",
                "Next Steps",
                "Send the final response.",
              ].join("\n"),
            }
          },
          async function* () {
            yield { type: "text.delta", text: "Compaction trace recorded." }
          },
        ],
        harness.observability.modelObserver,
      ),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      contextWindow: 13_050,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    const summarizeRun = harness.repository
      .runs
      .listBySession(harness.session.id)
      .find((run) => run.trigger === "summarize")
    const parentTrace = harness.observability.exportRunTrace(started.run.id)
    const summarizeTrace = summarizeRun
      ? harness.observability.exportRunTrace(summarizeRun.id)
      : null

    expect(readEventTypes(parentTrace?.events ?? [])).toContain("compaction.completed")
    expect(
      parentTrace?.events.find((event) => event.eventType === "compaction.completed")?.data,
    ).toMatchObject({
      summarizeRunId: summarizeRun?.id,
      tokensBefore: expect.any(Number),
      tokensAfter: expect.any(Number),
      compressionRatio: expect.any(Number),
    })
    expect(readEventTypes(summarizeTrace?.events ?? [])).toEqual([
      "run.started",
      "model.turn.requested",
      "model.prompt.assembled",
      "model.turn.usage",
      "run.completed",
    ])
  })

  test("records recovery skill loads after auto compaction", async () => {
    const harness = await createHarness("trace-compaction-recovery", false)
    const skillDirectory = join(harness.session.workspaceRoot, ".agents", "skills", "reviewer")

    await mkdir(skillDirectory, { recursive: true })
    await Bun.write(
      join(skillDirectory, "SKILL.md"),
      [
        "name: reviewer",
        "description: Review code changes carefully",
        "",
        "Focus on bugs first.",
      ].join("\n"),
    )

    harness.repository.sessions.update({
      sessionId: harness.session.id,
      activeSkills: ["reviewer"],
    })
    seedCompletedRunWithToolResults({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_trace_compaction_recovery_history",
      toolName: "shell",
      resultCount: 7,
      output: "shell output\n" + "x".repeat(4_000),
    })

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_compaction_recovery",
      messageId: "message_trace_compaction_recovery",
      prompt: "Continue after recovered compaction",
    })
    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* () {
            yield {
              type: "text.delta",
              text: [
                "Primary Request",
                "Continue after recovered compaction.",
                "",
                "Key Concepts",
                "Reload active skills after compaction.",
                "",
                "Files & Code",
                "README.md",
                "",
                "Errors & Fixes",
                "None.",
                "",
                "Problem Solving",
                "Compact first, then continue.",
                "",
                "User Messages",
                "Continue after recovered compaction",
                "",
                "Pending Tasks",
                "Finish the response.",
                "",
                "Current Work",
                "Replying after compaction.",
                "",
                "Next Steps",
                "Send the final response.",
              ].join("\n"),
            }
          },
          async function* () {
            yield { type: "text.delta", text: "Recovered compaction trace recorded." }
          },
        ],
        harness.observability.modelObserver,
      ),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      contextWindow: 13_050,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    const trace = harness.observability.exportRunTrace(started.run.id)
    const loadRequestedEvents = (trace?.events ?? []).filter(
      (event) => event.eventType === "skill.load.requested",
    )
    const loadCompletedEvents = (trace?.events ?? []).filter(
      (event) => event.eventType === "skill.load.completed",
    )

    expect(loadRequestedEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          skillName: "reviewer",
          reason: "recovery",
        }),
      }),
    ])
    expect(loadCompletedEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          skillName: "reviewer",
          skillPath: ".agents/skills/reviewer/SKILL.md",
          reason: "recovery",
        }),
      }),
    ])
  })

  test("opens the compaction circuit breaker after three automatic failures", async () => {
    const harness = await createHarness("trace-compaction-breaker", false)
    seedCompletedRunWithToolResults({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_trace_compaction_breaker_history",
      toolName: "shell",
      resultCount: 7,
      output: "shell output\n" + "x".repeat(4_000),
    })

    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* () {
            throw new Error("summary down 1")
          },
          async function* () {
            yield { type: "text.delta", text: "First run still replied." }
          },
          async function* () {
            throw new Error("summary down 2")
          },
          async function* () {
            yield { type: "text.delta", text: "Second run still replied." }
          },
          async function* () {
            throw new Error("summary down 3")
          },
          async function* () {
            yield { type: "text.delta", text: "Third run still replied." }
          },
          async function* () {
            yield { type: "text.delta", text: "Fourth run skipped compaction." }
          },
        ],
        harness.observability.modelObserver,
      ),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      contextWindow: 15_000,
      now: harness.now,
    })

    for (const suffix of ["one", "two", "three", "four"] as const) {
      const started = startPromptRun({
        repository: harness.repository,
        service: harness.service,
        sessionId: harness.session.id,
        runId: `run_trace_compaction_breaker_${suffix}`,
        messageId: `message_trace_compaction_breaker_${suffix}`,
        prompt: `Continue after ${suffix}`,
      })
      const handle = await runtime.run({
        sessionId: harness.session.id,
        runId: started.run.id,
      })
      await collectEvents(handle.events)
    }

    const summarizeRuns = harness.repository
      .runs
      .listBySession(harness.session.id)
      .filter((run) => run.trigger === "summarize")
    const thirdTrace = harness.observability.exportRunTrace("run_trace_compaction_breaker_three")
    const fourthTrace = harness.observability.exportRunTrace("run_trace_compaction_breaker_four")

    expect(summarizeRuns).toHaveLength(3)
    expect(summarizeRuns.map((run) => run.status)).toEqual(["failed", "failed", "failed"])
    expect(readEventTypes(thirdTrace?.events ?? [])).toEqual(
      expect.arrayContaining([
        "compaction.failed",
        "compaction.circuit_breaker.triggered",
      ]),
    )
    expect(readEventTypes(fourthTrace?.events ?? [])).not.toContain("compaction.failed")
    expect(readEventTypes(fourthTrace?.events ?? [])).not.toContain("compaction.completed")
  })

  test("manual compaction success resets the breaker so later runs can auto compact again", async () => {
    const harness = await createHarness("trace-compaction-manual-reset", false)
    seedCompletedRunWithToolResults({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_trace_compaction_manual_reset_history",
      toolName: "shell",
      resultCount: 7,
      output: "shell output\n" + "x".repeat(4_000),
    })
    const denseSummaryBlock = Array.from({ length: 80 }, () => "placeholder.txt").join("\n")

    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* () {
            throw new Error("summary down 1")
          },
          async function* () {
            yield { type: "text.delta", text: "First run still replied." }
          },
          async function* () {
            throw new Error("summary down 2")
          },
          async function* () {
            yield { type: "text.delta", text: "Second run still replied." }
          },
          async function* () {
            throw new Error("summary down 3")
          },
          async function* () {
            yield { type: "text.delta", text: "Third run still replied." }
          },
          async function* () {
            yield {
              type: "text.delta",
              text: [
                "Primary Request",
                "Keep working after the manual compact.",
                "",
                "Key Concepts",
                "The breaker should reset after a successful manual compaction.",
                "",
                "Files & Code",
                denseSummaryBlock,
                "",
                "Errors & Fixes",
                "Three automatic compactions failed earlier.",
                "",
                "Problem Solving",
                "Run a manual compact, then retry automatic compaction on the next prompt.",
                "",
                "User Messages",
                "Compact manually",
                "",
                "Pending Tasks",
                "Send the follow-up reply.",
                "",
                "Current Work",
                "Repairing the breaker state.",
                "",
                "Next Steps",
                "Answer the user.",
              ].join("\n"),
            }
          },
          async function* () {
            yield {
              type: "text.delta",
              text: [
                "Primary Request",
                "Keep working after the breaker reset.",
                "",
                "Key Concepts",
                "Automatic compaction is allowed again.",
                "",
                "Files & Code",
                "placeholder.txt",
                "",
                "Errors & Fixes",
                "The manual compact succeeded.",
                "",
                "Problem Solving",
                "Auto compact again before replying.",
                "",
                "User Messages",
                "Continue after the breaker reset",
                "",
                "Pending Tasks",
                "Send the final answer.",
                "",
                "Current Work",
                "Preparing the reply.",
                "",
                "Next Steps",
                "Answer the user.",
              ].join("\n"),
            }
          },
          async function* () {
            yield { type: "text.delta", text: "Auto compaction resumed." }
          },
        ],
        harness.observability.modelObserver,
      ),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      contextWindow: 15_000,
      now: harness.now,
    })

    for (const suffix of ["one", "two", "three"] as const) {
      const started = startPromptRun({
        repository: harness.repository,
        service: harness.service,
        sessionId: harness.session.id,
        runId: `run_trace_compaction_manual_reset_${suffix}`,
        messageId: `message_trace_compaction_manual_reset_${suffix}`,
        prompt: `Continue after ${suffix}`,
      })
      const handle = await runtime.run({
        sessionId: harness.session.id,
        runId: started.run.id,
      })
      await collectEvents(handle.events)
    }

    const manualRun = startCommandRun({
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_compaction_manual_reset_manual",
    })
    const manualHandle = await runtime.compactSession({
      sessionId: harness.session.id,
      runId: manualRun.run.id,
    })
    await collectEvents(manualHandle.events)
    seedCompletedRunWithToolResults({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_trace_compaction_manual_reset_followup_history",
      toolName: "shell",
      resultCount: 7,
      output: "post-compact shell output\n" + "y".repeat(4_000),
    })

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_compaction_manual_reset_four",
      messageId: "message_trace_compaction_manual_reset_four",
      prompt: "Continue after the breaker reset",
    })
    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    const summarizeRuns = harness.repository
      .runs
      .listBySession(harness.session.id)
      .filter((run) => run.trigger === "summarize")
    const fourthTrace = harness.observability.exportRunTrace(
      "run_trace_compaction_manual_reset_four",
    )

    expect(harness.repository.runs.get(manualRun.run.id)).toMatchObject({
      trigger: "command",
      status: "completed",
    })
    expect(summarizeRuns).toHaveLength(5)
    expect(summarizeRuns.map((run) => run.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "completed",
      "completed",
    ])
    expect(readEventTypes(fourthTrace?.events ?? [])).toContain("compaction.completed")
    expect(readEventTypes(fourthTrace?.events ?? [])).not.toContain(
      "compaction.circuit_breaker.triggered",
    )
  })

  test("records microcompact telemetry when projection clears older tool results", async () => {
    const harness = await createHarness("trace-microcompact", false)
    seedCompletedRunWithToolResults({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_trace_microcompact_history",
      toolName: "shell",
      resultCount: 7,
      output: "shell output\n" + "x".repeat(600),
    })

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_microcompact",
      messageId: "message_trace_microcompact",
      prompt: "Continue after the earlier shell work",
    })
    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* () {
            yield { type: "text.delta", text: "Compact enough to continue." }
          },
        ],
        harness.observability.modelObserver,
      ),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      contextWindow: 200,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    const trace = harness.observability.exportRunTrace(started.run.id)
    expect(readEventTypes(trace?.events ?? [])).toContain("microcompact.applied")
    const microcompactEvent = trace?.events.find((event) => event.eventType === "microcompact.applied")
    expect(microcompactEvent?.data).toMatchObject({
      clearedCount: 2,
      retainedCount: 5,
      estimatedTokensSaved: expect.any(Number),
    })
  })
})

async function createHarness(prefix: string, withFixtureWorkspace: boolean) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  const databasePath = join(directory, "agent.sqlite")
  if (withFixtureWorkspace) {
    await cp("test/fixtures/workspaces/read-search", workspaceRoot, { recursive: true })
  } else {
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")
  }

  const now = createMonotonicClock()
  const database = openSessionDatabase(databasePath)
  openDatabases.push(database)
  const repository = createSessionRepository({
    database,
    now,
  })
  const permissionRepository = createPermissionRepository({
    database,
    now,
  })
  const observabilityRepository = createObservabilityRepository({
    database,
    now,
  })
  const observability = createObservabilityRuntimeApi({
    repository: observabilityRepository,
    now,
  })
  const service = createSessionRunService({
    repository,
    now,
  })
  const session = repository.sessions.create({
    id: `${prefix}_session`,
    directory: workspaceRoot,
    workspaceRoot,
    createdAt: now(),
  })

  return {
    database,
    databasePath,
    repository,
    permissionRepository,
    observabilityRepository,
    observability,
    service,
    session,
    now,
  }
}

function closeTrackedDatabase(database: Database) {
  const index = openDatabases.indexOf(database)
  if (index !== -1) {
    openDatabases.splice(index, 1)
  }

  database.close(false)
}

function startPromptRun(input: {
  repository: SessionRepository
  permissionRepository?: PermissionRepository
  service: ReturnType<typeof createSessionRunService>
  sessionId: string
  runId: string
  messageId: string
  prompt: string
}) {
  const started = input.service.startRun({
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: input.messageId,
  })

  input.repository.parts.create({
    sessionId: input.sessionId,
    runId: started.run.id,
    messageId: started.message.id,
    kind: "text",
    sequence: 0,
    text: input.prompt,
  })

  return started
}

function startCommandRun(input: {
  service: ReturnType<typeof createSessionRunService>
  sessionId: string
  runId: string
}) {
  return input.service.startCommandRun({
    sessionId: input.sessionId,
    runId: input.runId,
  })
}

function seedCompletedRunWithToolResults(input: {
  repository: SessionRepository
  sessionId: string
  runId: string
  toolName: string
  resultCount: number
  output: string
}) {
  input.repository.runs.create({
    id: input.runId,
    sessionId: input.sessionId,
    trigger: "prompt",
    status: "completed",
  })
  const userMessage = input.repository.messages.create({
    id: `${input.runId}_user`,
    sessionId: input.sessionId,
    runId: input.runId,
    role: "user",
    sequence: 0,
  })
  input.repository.parts.create({
    id: `${input.runId}_user_part`,
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: userMessage.id,
    kind: "text",
    sequence: 0,
    text: "Previous tool-heavy work",
  })
  const assistantMessage = input.repository.messages.create({
    id: `${input.runId}_assistant`,
    sessionId: input.sessionId,
    runId: input.runId,
    role: "assistant",
    sequence: 1,
  })

  for (let index = 0; index < input.resultCount; index += 1) {
    input.repository.parts.create({
      id: `${input.runId}_tool_result_${index}`,
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: assistantMessage.id,
      kind: "tool_result",
      sequence: index,
      text: `${input.output}\n#${index}`,
      data: {
        callId: `${input.runId}_call_${index}`,
        toolName: input.toolName,
      },
    })
  }
}

function createTurnProvider(
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
  observer?: ReturnType<typeof createObservabilityRuntimeApi>["modelObserver"],
) {
  let index = 0

  return createModelProvider({
    observer,
    runtime: createModelRuntimeApi({
      async *streamTurn(request: ProviderTurnRequest) {
        const turn = turns[index]
        index += 1

        if (!turn) {
          throw new Error(`Unexpected provider turn ${index}`)
        }

        for await (const event of turn(request)) {
          yield event
        }
      },
    }),
  })
}

async function collectEvents(
  events: AsyncIterable<unknown>,
  input: {
    onEvent?(event: unknown): void
  } = {},
) {
  const collected = []
  for await (const event of events) {
    input.onEvent?.(event)
    collected.push(event)
  }
  return collected
}

function readEventTypes(events: StoredRunEvent[]) {
  return events.map((event) => event.eventType)
}

function createMonotonicClock() {
  let current = 100
  return () => {
    current += 1
    return current
  }
}
