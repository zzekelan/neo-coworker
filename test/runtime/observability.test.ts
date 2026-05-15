import { afterEach, describe, expect, test } from "bun:test"
import type OpenAI from "openai"
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
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
  createOpenAICompatibleModelProvider,
  type ProviderEvent,
  type ProviderTurnRequest,
} from "../../src/model"
import {
  createOrchestrationModelPort,
  createRuntime,
  createStandaloneServerComposition,
  type OrchestrationModelPort,
} from "../../src/bootstrap"
import { createBuiltinToolRuntime } from "../../src/tool"
import { createPermissionCoordinator } from "../../src/permission"
import { formatAnchorLine } from "../../src/tool/infrastructure/builtins/hash-anchor"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []

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
      "memory.loaded",
      "prompt.assembled",
      "tool.listed",
      "skill.catalog.exposed",
      "model.turn.requested",
      "model.prompt.assembled",
      "message.started",
      "model.turn.usage",
      "context.usage.updated",
      "tool.executed",
      "tool.call.completed",
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

  test("exports terminalization-created tool closures before terminal run events", async () => {
    const failedHarness = await createHarness("trace-failed-tool-closure", false)
    const failedRun = startPromptRun({
      repository: failedHarness.repository,
      service: failedHarness.service,
      sessionId: failedHarness.session.id,
      runId: "run_trace_failed_tool_closure",
      messageId: "message_trace_failed_tool_closure",
      prompt: "Fail after emitting a tool call",
    })
    const failedRuntime = createRuntime({
      provider: createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_trace_failed",
            name: "shell",
            inputText: '{"command":"pwd"}',
          }
          throw new Error("provider failed")
        },
      ]),
      repository: failedHarness.repository,
      permissionRepository: failedHarness.permissionRepository,
      observability: failedHarness.observability,
      now: failedHarness.now,
    })

    await collectEvents((await failedRuntime.run({
      sessionId: failedHarness.session.id,
      runId: failedRun.run.id,
    })).events)

    const failedTrace = failedHarness.observability.exportRunTrace(failedRun.run.id)
    const failedClosureIndex = (failedTrace?.events ?? []).findIndex(
      (event) => event.eventType === "tool.call.completed" && event.data.callId === "call_trace_failed",
    )
    const failedTerminalIndex = (failedTrace?.events ?? []).findIndex((event) => event.eventType === "run.failed")
    expect(failedTrace?.events[failedClosureIndex]?.data).toMatchObject({
      callId: "call_trace_failed",
      name: "shell",
      output: "Run failed before this tool call completed.",
      isError: true,
      errorCode: "RUN_FAILED_TOOL_CALL",
    })
    expect(failedClosureIndex).toBeGreaterThan(-1)
    expect(failedTerminalIndex).toBeGreaterThan(failedClosureIndex)

    const cancelledHarness = await createHarness("trace-cancelled-tool-closure", false)
    const cancelledRun = startPromptRun({
      repository: cancelledHarness.repository,
      service: cancelledHarness.service,
      sessionId: cancelledHarness.session.id,
      runId: "run_trace_cancelled_tool_closure",
      messageId: "message_trace_cancelled_tool_closure",
      prompt: "Cancel after emitting a tool call",
    })
    let resolveToolCallPersisted: () => void = () => {}
    const toolCallPersisted = new Promise<void>((resolve) => {
      resolveToolCallPersisted = resolve
    })
    const cancelledRuntime = createRuntime({
      provider: createTurnProvider([
        async function* (request: { signal: AbortSignal }) {
          yield {
            type: "tool.call",
            callId: "call_trace_cancelled",
            name: "shell",
            inputText: '{"command":"pwd"}',
          }
          resolveToolCallPersisted()
          await new Promise<void>((_, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                const error = new Error("cancelled by operator")
                error.name = "AbortError"
                reject(error)
              },
              { once: true },
            )
          })
        },
      ]),
      repository: cancelledHarness.repository,
      permissionRepository: cancelledHarness.permissionRepository,
      observability: cancelledHarness.observability,
      now: cancelledHarness.now,
    })

    const cancelledHandle = await cancelledRuntime.run({
      sessionId: cancelledHarness.session.id,
      runId: cancelledRun.run.id,
    })
    await toolCallPersisted
    cancelledHandle.cancel()
    await collectEvents(cancelledHandle.events)

    const cancelledTrace = cancelledHarness.observability.exportRunTrace(cancelledRun.run.id)
    const cancelledClosureIndex = (cancelledTrace?.events ?? []).findIndex(
      (event) => event.eventType === "tool.call.completed" && event.data.callId === "call_trace_cancelled",
    )
    const cancelledTerminalIndex = (cancelledTrace?.events ?? []).findIndex((event) => event.eventType === "run.cancelled")
    expect(cancelledTrace?.events[cancelledClosureIndex]?.data).toMatchObject({
      callId: "call_trace_cancelled",
      name: "shell",
      output: "Run was cancelled before this tool call completed.",
      isError: true,
      errorCode: "RUN_CANCELLED_TOOL_CALL",
    })
    expect(cancelledClosureIndex).toBeGreaterThan(-1)
    expect(cancelledTerminalIndex).toBeGreaterThan(cancelledClosureIndex)
  })

  test("captures subagent protocol telemetry across parent and child runs", async () => {
    const harness = await createHarness("trace-subagent-protocol", true)
    const childPrompt = "Collect a structured source note from README.md."
    const childReasoning = "Need to inspect allowed source-researcher tools before answering."
    const childOutput = "proposed type: files\ntitle: README\nkey excerpts: demo workspace"
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_subagent_protocol_parent",
      messageId: "message_trace_subagent_protocol_parent",
      prompt: "Delegate README source collection through the source researcher.",
    })
    const providerRequests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* (request) {
            providerRequests.push(request)
            yield {
              type: "tool.call",
              callId: "call_source_researcher",
              name: "agent",
              inputText: JSON.stringify({
                agent: "source-researcher",
                prompt: childPrompt,
              }),
            }
          },
          async function* (request) {
            providerRequests.push(request)
            yield { type: "reasoning.delta", text: childReasoning }
            yield { type: "text.delta", text: childOutput }
          },
          async function* (request) {
            providerRequests.push(request)
            yield { type: "text.delta", text: "Parent observed source researcher output." }
          },
        ],
        harness.observability.modelObserver,
      ),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      telemetry: createProtocolTelemetryFixture(),
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    const subSessions = harness.repository.sessions.listSubSessions(harness.session.id)
    expect(subSessions).toHaveLength(1)
    const childSession = subSessions[0]!
    const childRuns = harness.repository.runs.listBySession(childSession.id)
    expect(childRuns).toHaveLength(1)
    const childRun = childRuns[0]!

    const parentTrace = harness.observability.exportRunTrace(started.run.id)
    const childTrace = harness.observability.exportRunTrace(childRun.id)
    expect(parentTrace).not.toBeNull()
    expect(childTrace).not.toBeNull()
    expect(providerRequests).toHaveLength(3)

    assertSubagentProtocolTelemetryBaseline({
      parentRunId: started.run.id,
      childRun,
      parentTraceEvents: parentTrace?.events ?? [],
      childTraceEvents: childTrace?.events ?? [],
      parentTimeline: harness.repository.messages.listSessionTimeline(harness.session.id),
      childTimeline: harness.repository.messages.listSessionTimeline(childSession.id),
      parentAgentCallId: "call_source_researcher",
      childPrompt,
      childReasoning,
      childOutput,
      childAllowedToolNames: providerRequests[1]!.tools.map((tool) => tool.name),
      expectedProvider: "openai-compatible",
      expectedModel: "deepseek-reasoner",
    })
  })

  test("replays child reasoning for DeepSeek-compatible subagent tool turns without visible leaks", async () => {
    const harness = await createHarness("trace-subagent-reasoning-replay", true)
    const childPrompt = "Read README.md for a source note."
    const childReasoning = "Need to read README before writing the source note."
    const childOutput = "proposed type: files\ntitle: README\nkey excerpts: Neo Coworker"
    const receivedBodies: unknown[] = []
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_subagent_reasoning_replay_parent",
      messageId: "message_trace_subagent_reasoning_replay_parent",
      prompt: "Delegate README source collection through the source researcher.",
    })
    const provider = createOrchestrationModelPort(createOpenAICompatibleModelProvider({
      model: "deepseek-reasoner",
      observer: harness.observability.modelObserver,
      requestConfig: {
        replayedReasoningField: "reasoning_content",
      },
      client: createMockOpenAICompatibleClient(async (body) => {
        receivedBodies.push(body)

        return (async function* () {
          switch (receivedBodies.length) {
            case 1:
              yield createOpenAICompatibleChunk({
                tool_calls: [createOpenAICompatibleToolCallChunk({
                  index: 0,
                  id: "call_source_researcher",
                  name: "agent",
                  argumentsText: JSON.stringify({
                    agent: "source-researcher",
                    prompt: childPrompt,
                  }),
                })],
              })
              yield createOpenAICompatibleChunk({}, "tool_calls")
              return
            case 2:
              yield createOpenAICompatibleChunk({
                reasoning_content: childReasoning,
              })
              yield createOpenAICompatibleChunk({
                tool_calls: [createOpenAICompatibleToolCallChunk({
                  index: 0,
                  id: "call_child_read",
                  name: "read",
                  argumentsText: JSON.stringify({ path: "README.md" }),
                })],
              })
              yield createOpenAICompatibleChunk({}, "tool_calls")
              return
            case 3:
              yield createOpenAICompatibleChunk({ content: childOutput })
              return
            case 4:
              yield createOpenAICompatibleChunk({ content: "Parent observed source researcher output." })
              return
            default:
              throw new Error(`Unexpected OpenAI-compatible provider turn ${receivedBodies.length}`)
          }
        })()
      }),
    }))
    const runtime = createRuntime({
      provider,
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      thinking: {
        enabled: true,
      },
      telemetry: createProtocolTelemetryFixture(),
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    expect(receivedBodies).toHaveLength(4)
    const childReplayAssistant = readAssistantReplayWithToolCalls(receivedBodies[2])
    expect(childReplayAssistant).toMatchObject({
      role: "assistant",
      content: null,
      reasoning_content: childReasoning,
      tool_calls: [
        expect.objectContaining({
          id: "call_child_read",
          function: expect.objectContaining({
            name: "read",
            arguments: JSON.stringify({ path: "README.md" }),
          }),
        }),
      ],
    })

    const subSessions = harness.repository.sessions.listSubSessions(harness.session.id)
    expect(subSessions).toHaveLength(1)
    const childSession = subSessions[0]!
    const childRun = harness.repository.runs.listBySession(childSession.id)[0]!
    const parentTimeline = harness.repository.messages.listSessionTimeline(harness.session.id)
    const childTimeline = harness.repository.messages.listSessionTimeline(childSession.id)
    const childReasoningPart = childTimeline
      .flatMap((message) => message.parts)
      .find((part) => part.kind === "reasoning")
    const parentVisibleText = readVisibleTimelineText(parentTimeline)
    const childVisibleText = readVisibleTimelineText(childTimeline)
    const parentAgentResult = parentTimeline
      .flatMap((message) => message.parts)
      .find(
        (part) =>
          part.kind === "tool_result" &&
          (part.data as { callId?: string } | undefined)?.callId === "call_source_researcher",
      )

    expect(childRun.status).toBe("completed")
    expect(childReasoningPart).toMatchObject({
      kind: "reasoning",
      text: childReasoning,
    })
    expect(parentAgentResult?.text).toBe(childOutput)
    expect(parentAgentResult?.text).not.toContain(childReasoning)
    expect(parentVisibleText).toContain(childOutput)
    expect(parentVisibleText).not.toContain(childReasoning)
    expect(childVisibleText).toContain(childOutput)
    expect(childVisibleText).not.toContain(childReasoning)
  })

  test("persists per-request permission lifecycle events for multi-pending ask-mode tools", async () => {
    const harness = await createHarness("trace-permission", false)
    const firstUrl = "data:text/plain,Hello%20from%20the%20first%20observability%20fetch."
    const secondUrl = "data:text/plain,Hello%20from%20the%20second%20observability%20fetch."
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_permission",
      messageId: "message_trace_permission",
      prompt: "Fetch two notes for observability",
    })
    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* () {
            yield {
              type: "tool.call",
              callId: "call_webfetch_1",
              name: "webfetch",
              inputText: `{"url":"${firstUrl}"}`,
            }
            yield {
              type: "tool.call",
              callId: "call_webfetch_2",
              name: "webfetch",
              inputText: `{"url":"${secondUrl}"}`,
            }
          },
          async function* () {
            yield { type: "text.delta", text: "Both fetches completed." }
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
    let firstRequestId: string | null = null
    let secondRequestId: string | null = null
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
          if (firstRequestId == null) {
            firstRequestId = event.requestId
            return
          }

          if (secondRequestId == null) {
            secondRequestId = event.requestId
            handle.respondPermission({
              requestId: event.requestId,
              decision: "allow",
            })
            handle.respondPermission({
              requestId: firstRequestId,
              decision: "allow",
            })
          }
        }
      },
    })

    expect(firstRequestId).not.toBeNull()
    expect(secondRequestId).not.toBeNull()

    const trace = harness.observability.exportRunTrace(started.run.id)
    expect(trace).not.toBeNull()

    const permissionLifecycle = (trace?.events ?? []).filter(
      (event) =>
        event.source === "permission" &&
        (event.eventType === "permission.requested" || event.eventType === "permission.responded"),
    )

    expect(permissionLifecycle).toEqual([
      expect.objectContaining({
        eventType: "permission.requested",
        data: expect.objectContaining({
          requestId: firstRequestId,
          toolName: "webfetch",
          reason: `webfetch ${firstUrl}`,
        }),
      }),
      expect.objectContaining({
        eventType: "permission.requested",
        data: expect.objectContaining({
          requestId: secondRequestId,
          toolName: "webfetch",
          reason: `webfetch ${secondUrl}`,
        }),
      }),
      expect.objectContaining({
        eventType: "permission.responded",
        data: expect.objectContaining({
          requestId: secondRequestId,
          decision: "allow",
        }),
      }),
      expect.objectContaining({
        eventType: "permission.responded",
        data: expect.objectContaining({
          requestId: firstRequestId,
          decision: "allow",
        }),
      }),
    ])

    const orchestrationPermissionRequests = (trace?.events ?? []).filter(
      (event) => event.source === "orchestration" && event.eventType === "permission.requested",
    )
    expect(orchestrationPermissionRequests).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          requestId: firstRequestId,
          toolName: "webfetch",
          reason: `webfetch ${firstUrl}`,
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          requestId: secondRequestId,
          toolName: "webfetch",
          reason: `webfetch ${secondUrl}`,
        }),
      }),
    ])

    const lastPermissionResponseIndex = (trace?.events ?? []).findLastIndex(
      (event) =>
        event.source === "permission" &&
        event.eventType === "permission.responded" &&
        event.data.requestId === firstRequestId,
    )
    const runCompletedIndex = (trace?.events ?? []).findIndex((event) => event.eventType === "run.completed")

    expect(lastPermissionResponseIndex).toBeGreaterThanOrEqual(0)
    expect(runCompletedIndex).toBeGreaterThan(lastPermissionResponseIndex)
  })

  test("exports persisted multi-request permission traces after reopening the same storage file", async () => {
    const harness = await createHarness("trace-reopen", true)
    const firstUrl = "data:text/plain,Hello%20from%20the%20first%20reopen%20fetch."
    const secondUrl = "data:text/plain,Hello%20from%20the%20second%20reopen%20fetch."
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_reopen",
      messageId: "message_trace_reopen",
      prompt: "Fetch two notes and reopen the trace",
    })
    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* () {
            yield {
              type: "tool.call",
              callId: "call_webfetch_reopen_1",
              name: "webfetch",
              inputText: `{"url":"${firstUrl}"}`,
            }
            yield {
              type: "tool.call",
              callId: "call_webfetch_reopen_2",
              name: "webfetch",
              inputText: `{"url":"${secondUrl}"}`,
            }
          },
          async function* () {
            yield { type: "text.delta", text: "Trace after reopen." }
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
    const pendingRequestIds: string[] = []
    await collectEvents(handle.events, {
      onEvent(event) {
        if (
          typeof event !== "object" ||
          event === null ||
          !("type" in event) ||
          event.type !== "permission.requested" ||
          !("requestId" in event) ||
          typeof event.requestId !== "string"
        ) {
          return
        }

        pendingRequestIds.push(event.requestId)
        if (pendingRequestIds.length === 2) {
          handle.respondPermission({
            requestId: pendingRequestIds[1]!,
            decision: "allow",
          })
          handle.respondPermission({
            requestId: pendingRequestIds[0]!,
            decision: "allow",
          })
        }
      },
    })

    const initialTrace = harness.observability.exportRunTrace(started.run.id)
    expect(initialTrace).not.toBeNull()
    expect(readEventTypes(initialTrace?.events ?? [])).toEqual(
      expect.arrayContaining([
        "permission.requested",
        "permission.responded",
        "run.completed",
      ]),
    )

    const initialPermissionLifecycle = (initialTrace?.events ?? []).filter(
      (event) =>
        event.source === "permission" &&
        (event.eventType === "permission.requested" || event.eventType === "permission.responded"),
    )
    expect(initialPermissionLifecycle).toEqual([
      expect.objectContaining({
        eventType: "permission.requested",
        data: expect.objectContaining({
          requestId: pendingRequestIds[0],
          toolName: "webfetch",
          reason: `webfetch ${firstUrl}`,
        }),
      }),
      expect.objectContaining({
        eventType: "permission.requested",
        data: expect.objectContaining({
          requestId: pendingRequestIds[1],
          toolName: "webfetch",
          reason: `webfetch ${secondUrl}`,
        }),
      }),
      expect.objectContaining({
        eventType: "permission.responded",
        data: expect.objectContaining({
          requestId: pendingRequestIds[1],
          decision: "allow",
        }),
      }),
      expect.objectContaining({
        eventType: "permission.responded",
        data: expect.objectContaining({
          requestId: pendingRequestIds[0],
          decision: "allow",
        }),
      }),
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
      expect(reopenedObservability.exportRunTrace(started.run.id)?.events).toEqual(initialTrace?.events)
    } finally {
      reopenedDatabase.close(false)
    }
  })

  test("records skill disclosure telemetry before and after activation", async () => {
    const harness = await createHarness("trace-skill", false)
  const skillDirectory = join(harness.session.workspaceRoot, ".ncoworker", "skills", "reviewer")

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
      catalogSkillNames: ["deep-research", "finding-synthesis", "reviewer", "source-note"],
      activeSkillNames: [],
      activeSkillCount: 0,
      systemPromptLength: expect.any(Number),
      systemReminderLength: expect.any(Number),
    })
    expect(promptEvents[1]?.data).toMatchObject({
      catalogSkillNames: [],
      activeSkillNames: ["reviewer"],
      activeSkillCount: 1,
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
          catalogSkillNames: ["deep-research", "finding-synthesis", "reviewer", "source-note"],
          catalogSkillCount: 4,
        }),
      }),
    ])
    expect(loadCompletedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            skillName: "reviewer",
        skillPath: ".ncoworker/skills/reviewer/SKILL.md",
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
                "Summaries replace earlier timeline chunks.",
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
  const skillDirectory = join(harness.session.workspaceRoot, ".ncoworker", "skills", "reviewer")

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
          reason: "prompt",
        }),
      }),
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
        skillPath: ".ncoworker/skills/reviewer/SKILL.md",
          reason: "prompt",
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          skillName: "reviewer",
        skillPath: ".ncoworker/skills/reviewer/SKILL.md",
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
      toolName: "read",
      resultCount: 7,
      output: "L1#839b9d95|previous read output\nL2#5130b33e|" + "x".repeat(600),
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

  test("records anchor edit success telemetry without persisting source snippets", async () => {
    const harness = await createHarness("trace-anchor-success", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_anchor_success",
      messageId: "message_trace_anchor_success",
      prompt: "Record successful anchor edit telemetry",
    })

    harness.observability.toolObserver.recordToolEvent({
      type: "edit.anchor.success",
      sessionId: harness.session.id,
      runId: started.run.id,
      path: "src/tool/infrastructure/builtins/edit.ts",
      operation: "replace",
      rangeLength: 1,
      durationMs: 9,
      fallbackUsed: false,
      fileSizeBytes: 2048,
    })
    harness.observability.toolObserver.recordToolEvent({
      type: "file.lock.waited",
      sessionId: harness.session.id,
      runId: started.run.id,
      path: "src/tool/infrastructure/builtins/edit.ts",
      operation: "replace",
      durationMs: 4,
    })

    const trace = harness.observability.exportRunTrace(started.run.id)
    expect(trace).not.toBeNull()
    expect(readEventTypes(trace?.events ?? [])).toEqual([
      "edit.anchor.success",
      "file.lock.waited",
    ])

    const successEvent = trace?.events.find((event) => event.eventType === "edit.anchor.success")
    expect(successEvent).toEqual(
      expect.objectContaining({
        source: "tool",
        data: {
          path: "src/tool/infrastructure/builtins/edit.ts",
          operation: "replace",
          rangeLength: 1,
          durationMs: 9,
          fallbackUsed: false,
          fileSizeBytes: 2048,
        },
      }),
    )
    expect(successEvent?.data).not.toHaveProperty("content")
    expect(successEvent?.data).not.toHaveProperty("insertedContent")
    expect(successEvent?.data).not.toHaveProperty("oldText")
    expect(successEvent?.data).not.toHaveProperty("newText")

    const persistedRunEventJson = readPersistedRunEventJson({
      databasePath: harness.databasePath,
      runId: started.run.id,
    })
    expect(persistedRunEventJson.join("\n")).not.toContain("private source snippet")
    expect(persistedRunEventJson.join("\n")).not.toContain("inserted replacement text")
  })

  test("records stale anchor failure telemetry without persisting content", async () => {
    const harness = await createHarness("trace-anchor-stale", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_anchor_stale",
      messageId: "message_trace_anchor_stale",
      prompt: "Record stale anchor telemetry",
    })

    harness.observability.toolObserver.recordToolEvent({
      type: "edit.anchor.failure",
      sessionId: harness.session.id,
      runId: started.run.id,
      path: "src/tool/infrastructure/builtins/edit.ts",
      operation: "replace",
      rangeLength: 1,
      durationMs: 7,
      fallbackUsed: false,
      fileSizeBytes: 2048,
      failureReason: "stale_anchor",
    })

    const trace = harness.observability.exportRunTrace(started.run.id)
    expect(trace).not.toBeNull()
    expect(readEventTypes(trace?.events ?? [])).toEqual(["edit.anchor.failure"])

    const failureEvent = trace?.events[0]
    expect(failureEvent).toEqual(
      expect.objectContaining({
        source: "tool",
        eventType: "edit.anchor.failure",
        data: {
          path: "src/tool/infrastructure/builtins/edit.ts",
          operation: "replace",
          rangeLength: 1,
          durationMs: 7,
          fallbackUsed: false,
          fileSizeBytes: 2048,
          failureReason: "stale_anchor",
        },
      }),
    )
    expect(failureEvent?.data).not.toHaveProperty("content")
    expect(failureEvent?.data).not.toHaveProperty("insertedContent")
    expect(failureEvent?.data).not.toHaveProperty("oldText")
    expect(failureEvent?.data).not.toHaveProperty("newText")

    const persistedRunEventJson = readPersistedRunEventJson({
      databasePath: harness.databasePath,
      runId: started.run.id,
    })
    expect(persistedRunEventJson.join("\n")).not.toContain("private source snippet")
    expect(persistedRunEventJson.join("\n")).not.toContain("inserted replacement text")
  })

  test("records apply_patch completion telemetry without persisting diff or raw patch content", async () => {
    const harness = await createHarness("trace-apply-patch-summary", false)
    await Bun.write(join(harness.session.directory, "private.txt"), "original-secret\n")
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_apply_patch_summary",
      messageId: "message_trace_apply_patch_summary",
      prompt: "Patch private.txt without leaking contents into telemetry",
    })

    const runtime = createRuntime({
      provider: createTurnProvider(
        [
          async function* () {
            yield {
              type: "tool.call",
              callId: "call_apply_patch_summary",
              name: "apply_patch",
              inputText: JSON.stringify({
                patchText: [
                  "*** Begin Patch",
                  "*** Update File: private.txt",
                  "@@",
                  "-original-secret",
                  "+replacement-secret",
                  "*** End Patch",
                  "",
                ].join("\n"),
              }),
            }
          },
          async function* () {
            yield { type: "text.delta", text: "Patch summary recorded." }
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
    let livePermissionRequest: unknown
    await collectEvents(handle.events, {
      onEvent(event) {
        if (
          typeof event !== "object" ||
          event === null ||
          !("type" in event) ||
          event.type !== "permission.requested" ||
          !("requestId" in event) ||
          typeof event.requestId !== "string"
        ) {
          return
        }

        livePermissionRequest = event
        handle.respondPermission({
          requestId: event.requestId,
          decision: "allow",
        })
      },
    })

    expect(livePermissionRequest).toMatchObject({
      type: "permission.requested",
      toolName: "apply_patch",
      approvalDetails: {
        kind: "patch",
        fileCount: 1,
        additions: 1,
        deletions: 1,
      },
      preview: {
        kind: "patch",
        text: expect.stringContaining("original-secret"),
      },
    })

    const trace = harness.observability.exportRunTrace(started.run.id)
    const completionEvent = trace?.events.find(
      (event) => event.eventType === "tool.call.completed" &&
        event.data.name === "apply_patch",
    )
    expect(completionEvent?.data).toMatchObject({
      callId: "call_apply_patch_summary",
      name: "apply_patch",
      output: "Applied patch to 1 file: private.txt (update, +1/-1).",
    })
    const persistedRunEventJson = readPersistedRunEventJson({
      databasePath: harness.databasePath,
      runId: started.run.id,
    }).join("\n")
    expect(persistedRunEventJson).toContain("private.txt")
    expect(persistedRunEventJson).toContain("+1/-1")
    expect(persistedRunEventJson).not.toContain("\"preview\"")
    expect(persistedRunEventJson).not.toContain("*** Update File: private.txt")
    expect(persistedRunEventJson).not.toContain("--- a/private.txt")
    expect(persistedRunEventJson).not.toContain("+++ b/private.txt")
    expect(persistedRunEventJson).not.toContain("original-secret")
    expect(persistedRunEventJson).not.toContain("replacement-secret")
  })

  test("records live edit anchor telemetry through the runtime path", async () => {
    const harness = await createHarness("trace-live-edit-anchor", true)
    const workspaceFile = join(harness.session.directory, "README.md")
    const original = await readFile(workspaceFile, "utf8")
    if (original.length === 0) {
      throw new Error("Expected fixture README.md to exist in the workspace.")
    }
    const firstLine = original.split(/\r?\n/, 1)[0] ?? ""
    const liveAnchor = formatAnchorLine(1, firstLine)

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_live_edit_anchor",
      messageId: "message_trace_live_edit_anchor",
      prompt: "Use edit and emit live anchor telemetry",
    })

    const runtime = createBuiltinToolRuntime({
      requestPermission: createPermissionCoordinator({ write: "allow", edit: "allow", shell: "allow" }).request,
      observer: harness.observability.toolObserver,
      observerContext: {
        sessionId: harness.session.id,
        runId: started.run.id,
      },
    })

    const success = await runtime.execute({
      toolName: "edit",
      args: {
        path: "README.md",
        operation: "replace",
        start: liveAnchor,
        content: `${firstLine} live`,
      },
      workspaceRoot: harness.session.directory,
    })
    expect(success.isError).toBeFalsy()

    const failure = await runtime.execute({
      toolName: "edit",
      args: {
        path: "README.md",
        operation: "replace",
        start: liveAnchor,
        content: `${firstLine} stale`,
      },
      workspaceRoot: harness.session.directory,
    })
    expect(failure.isError).toBe(true)

    const trace = harness.observability.exportRunTrace(started.run.id)
    expect(trace).not.toBeNull()
    const eventTypes = readEventTypes(trace?.events ?? [])
    expect(eventTypes).toContain("edit.anchor.success")
    expect(eventTypes).toContain("edit.anchor.failure")

    const toolEvents = (trace?.events ?? []).filter((event) => event.source === "tool")
    expect(JSON.stringify(toolEvents)).not.toContain("oldText")
    expect(JSON.stringify(toolEvents)).not.toContain("newText")
    expect(JSON.stringify(toolEvents)).not.toContain("replaceAll")
    expect(JSON.stringify(toolEvents)).not.toContain("# Neo Coworker")
  })

  test("records authoritative capability and context source telemetry without persisting reasoning payload text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trace-capability-authority-"))
    tempDirectories.push(directory)
    const workspaceRoot = join(directory, "workspace")
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

    const now = createMonotonicClock()
    const composition = await createStandaloneServerComposition({
      cwd: directory,
      now,
      env: {
        LLM_PROVIDER: "openai-compatible",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "kimi-k2.6",
        LLM_BASE_URL: "https://api.moonshot.ai/v1",
        NCOWORKER_SERVER_DB_PATH: join(directory, "server.sqlite"),
      },
      resolveProviderCapabilitiesImpl: async () => ({
        provider: "openai-compatible",
        providerId: "moonshotai",
        model: "kimi-k2.6",
        catalog: {
          source: "models.dev",
          miss: false,
        },
        reasoning: {
          supported: true,
          source: "models.dev",
        },
        toolCall: {
          supported: true,
          source: "models.dev",
        },
        interleaved: {
          supported: true,
          field: "reasoning_content",
          source: "models.dev",
        },
        reasoningEffort: {
          supported: true,
          source: "models.dev",
        },
        thinkingControls: {
          thinking: {
            supported: true,
            source: "override",
          },
          reasoningEffort: {
            supported: true,
            source: "override",
          },
        },
      }),
      resolveContextWindowSizeImpl: async () => ({
        contextWindow: 65_536,
        source: "provider",
      }),
      createDefaultProviderImpl: async (providerInput = {}) =>
        createModelProvider({
          observer: providerInput.modelObserver,
          replayGuard: providerInput.replayGuard,
          runtime: createModelRuntimeApi({
            async *streamTurn() {
              yield { type: "text.delta", text: "Telemetry classification complete." }
            },
          }),
        }),
    })

    try {
      const service = createSessionRunService({
        repository: composition.repository,
        now,
      })
      const session = composition.repository.sessions.create({
        id: "trace_capability_authority_session",
        directory: workspaceRoot,
        workspaceRoot,
        createdAt: now(),
      })
      seedCompletedAssistantReasoningRun({
        repository: composition.repository,
        sessionId: session.id,
        runId: "run_trace_capability_reasoning_history",
        reasoningText: "private reasoning payload that must never be stored in telemetry",
      })

      const started = startPromptRun({
        repository: composition.repository,
        service,
        sessionId: session.id,
        runId: "run_trace_capability_authority",
        messageId: "message_trace_capability_authority",
        prompt: "Confirm the capability telemetry path.",
      })
      const runtime = composition.createRuntimeImpl({
        repository: composition.repository,
        permissionRepository: composition.permissionRepository,
        now,
      })

      const handle = await runtime.run({
        sessionId: session.id,
        runId: started.run.id,
      })
      await collectEvents(handle.events)

      const trace = composition.exportRunTrace(started.run.id)
      expect(trace).not.toBeNull()
      expect(readEventTypes(trace?.events ?? [])).toEqual(
        expect.arrayContaining([
          "capability.resolution.recorded",
          "context.window.resolved",
          "model.turn.requested",
          "kimi.run.classified",
          "run.completed",
        ]),
      )

      const capabilityEvent = trace?.events.find(
        (event) => event.eventType === "capability.resolution.recorded",
      )
      expect(capabilityEvent?.data).toEqual({
        model: "kimi-k2.6",
        provider: "openai-compatible",
        providerFamily: "kimi",
        catalogSource: "models.dev",
        catalogMiss: false,
        reasoningSource: "models.dev",
        toolCallSource: "models.dev",
        interleavedSource: "models.dev",
        interleavedField: "reasoning_content",
        reasoningEffortSource: "models.dev",
        thinkingSource: "config",
        thinkingEffortSource: "config",
      })

      const contextWindowEvent = trace?.events.find(
        (event) => event.eventType === "context.window.resolved",
      )
      expect(contextWindowEvent?.data).toEqual({
        contextWindow: 65_536,
        source: "/models",
      })

      const kimiClassification = trace?.events.find((event) => event.eventType === "kimi.run.classified")
      expect(kimiClassification?.data).toEqual({
        model: "kimi-k2.6",
        outcome: "success",
      })

      composition.closeDatabase()
      const persistedRunEventJson = readPersistedRunEventJson({
        databasePath: composition.config.databasePath,
        runId: started.run.id,
      })
      expect(persistedRunEventJson.join("\n")).not.toContain(
        "private reasoning payload that must never be stored in telemetry",
      )
    } finally {
      composition.closeDatabase()
    }
  })

  test("records models.dev misses with default fallbacks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trace-capability-miss-"))
    tempDirectories.push(directory)
    const workspaceRoot = join(directory, "workspace")
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

    const now = createMonotonicClock()
    const composition = await createStandaloneServerComposition({
      cwd: directory,
      now,
      env: {
        LLM_PROVIDER: "openai-compatible",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "unknown-model",
        LLM_BASE_URL: "https://example.invalid/v1",
        NCOWORKER_SERVER_DB_PATH: join(directory, "server.sqlite"),
      },
      resolveProviderCapabilitiesImpl: async () => ({
        provider: "openai-compatible",
        providerId: null,
        model: "unknown-model",
        catalog: {
          source: "default",
          miss: true,
        },
        reasoning: {
          supported: false,
          source: "default",
        },
        toolCall: {
          supported: true,
          source: "default",
        },
        interleaved: {
          supported: false,
          field: null,
          source: "default",
        },
        reasoningEffort: {
          supported: false,
          source: "default",
        },
        thinkingControls: {
          thinking: {
            supported: false,
            source: "default",
          },
          reasoningEffort: {
            supported: false,
            source: "default",
          },
        },
      }),
      resolveContextWindowSizeImpl: async () => ({
        contextWindow: 192_000,
        source: "default",
      }),
      createDefaultProviderImpl: async (providerInput = {}) =>
        createModelProvider({
          observer: providerInput.modelObserver,
          replayGuard: providerInput.replayGuard,
          runtime: createModelRuntimeApi({
            async *streamTurn() {
              yield { type: "text.delta", text: "Default fallback telemetry complete." }
            },
          }),
        }),
    })

    try {
      const service = createSessionRunService({
        repository: composition.repository,
        now,
      })
      const session = composition.repository.sessions.create({
        id: "trace_capability_miss_session",
        directory: workspaceRoot,
        workspaceRoot,
        createdAt: now(),
      })
      const started = startPromptRun({
        repository: composition.repository,
        service,
        sessionId: session.id,
        runId: "run_trace_capability_miss",
        messageId: "message_trace_capability_miss",
        prompt: "Confirm the default fallback telemetry path.",
      })
      const runtime = composition.createRuntimeImpl({
        repository: composition.repository,
        permissionRepository: composition.permissionRepository,
        now,
      })

      const handle = await runtime.run({
        sessionId: session.id,
        runId: started.run.id,
      })
      await collectEvents(handle.events)

      const trace = composition.exportRunTrace(started.run.id)
      expect(trace).not.toBeNull()
      expect(trace?.events.find((event) => event.eventType === "capability.resolution.recorded")?.data).toEqual({
        model: "unknown-model",
        provider: "openai-compatible",
        providerFamily: "generic",
        catalogSource: "default",
        catalogMiss: true,
        reasoningSource: "default",
        toolCallSource: "default",
        interleavedSource: "default",
        interleavedField: null,
        reasoningEffortSource: "default",
        thinkingSource: "default",
        thinkingEffortSource: "default",
      })
      expect(trace?.events.find((event) => event.eventType === "context.window.resolved")?.data).toEqual({
        contextWindow: 192_000,
        source: "default",
      })
      expect(readEventTypes(trace?.events ?? [])).not.toContain("kimi.run.classified")
    } finally {
      composition.closeDatabase()
    }
  })

  test("uses authoritative runtime thinking and preserves models.dev context-source telemetry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trace-authoritative-kimi-replay-"))
    tempDirectories.push(directory)
    const workspaceRoot = join(directory, "workspace")
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

    let providerInvocationCount = 0
    const now = createMonotonicClock()
    const composition = await createStandaloneServerComposition({
      cwd: directory,
      now,
      env: {
        LLM_PROVIDER: "openai-compatible",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "kimi-k2.6",
        LLM_BASE_URL: "https://api.moonshot.ai/v1",
        NCOWORKER_SERVER_DB_PATH: join(directory, "server.sqlite"),
      },
      resolveProviderCapabilitiesImpl: async () => ({
        provider: "openai-compatible",
        providerId: "moonshotai",
        model: "kimi-k2.6",
        catalog: {
          source: "models.dev",
          miss: false,
        },
        reasoning: {
          supported: true,
          source: "models.dev",
        },
        toolCall: {
          supported: true,
          source: "models.dev",
        },
        interleaved: {
          supported: true,
          field: "reasoning_content",
          source: "models.dev",
        },
        reasoningEffort: {
          supported: true,
          source: "models.dev",
        },
        thinkingControls: {
          thinking: {
            supported: true,
            source: "models.dev",
          },
          reasoningEffort: {
            supported: true,
            source: "models.dev",
          },
        },
      }),
      resolveContextWindowSizeImpl: async () => ({
        contextWindow: 262_144,
        source: "models.dev",
      }),
      createDefaultProviderImpl: async (providerInput = {}) =>
        createModelProvider({
          observer: providerInput.modelObserver,
          replayGuard: providerInput.replayGuard,
          runtime: createModelRuntimeApi({
            async *streamTurn() {
              providerInvocationCount += 1
              yield { type: "text.delta", text: "Provider should not be called." }
            },
          }),
        }),
    })

    try {
      const service = createSessionRunService({
        repository: composition.repository,
        now,
      })
      const session = composition.repository.sessions.create({
        id: "trace_authoritative_kimi_replay_session",
        directory: workspaceRoot,
        workspaceRoot,
        createdAt: now(),
      })
      seedCompletedAssistantReasoningRun({
        repository: composition.repository,
        sessionId: session.id,
        runId: "run_trace_authoritative_kimi_replay_reasoning_history",
        reasoningText: "private reasoning payload that must never be stored in telemetry",
      })
      seedLegacyAssistantToolReplayRun({
        repository: composition.repository,
        sessionId: session.id,
        runId: "run_trace_authoritative_kimi_replay_legacy_history",
      })

      const started = startPromptRun({
        repository: composition.repository,
        service,
        sessionId: session.id,
        runId: "run_trace_authoritative_kimi_replay",
        messageId: "message_trace_authoritative_kimi_replay",
        prompt: "Continue the Kimi session through the authoritative runtime.",
      })
      const runtime = composition.createRuntimeImpl({
        repository: composition.repository,
        permissionRepository: composition.permissionRepository,
        now,
      })

      const handle = await runtime.run({
        sessionId: session.id,
        runId: started.run.id,
      })
      await collectEvents(handle.events)

      expect(providerInvocationCount).toBe(1)

      const trace = composition.exportRunTrace(started.run.id)
      expect(trace).not.toBeNull()
      const eventTypes = readEventTypes(trace?.events ?? [])
      expect(eventTypes).toContain("model.turn.requested")
      expect(eventTypes).toContain("model.prompt.assembled")
      expect(eventTypes).toContain("run.completed")
      expect(eventTypes).not.toContain("replay.fail_fast.blocked")
      expect(eventTypes).not.toContain("error.classified")

      expect(trace?.events.find((event) => event.eventType === "capability.resolution.recorded")?.data).toEqual({
        model: "kimi-k2.6",
        provider: "openai-compatible",
        providerFamily: "kimi",
        catalogSource: "models.dev",
        catalogMiss: false,
        reasoningSource: "models.dev",
        toolCallSource: "models.dev",
        interleavedSource: "models.dev",
        interleavedField: "reasoning_content",
        reasoningEffortSource: "models.dev",
        thinkingSource: "models.dev",
        thinkingEffortSource: "models.dev",
      })
      expect(trace?.events.find((event) => event.eventType === "context.window.resolved")?.data).toEqual({
        contextWindow: 262_144,
        source: "models.dev",
      })
      expect(trace?.events.find((event) => event.eventType === "kimi.run.classified")?.data).toEqual({
        model: "kimi-k2.6",
        outcome: "success",
      })

      composition.closeDatabase()
      const persistedRunEventJson = readPersistedRunEventJson({
        databasePath: composition.config.databasePath,
        runId: started.run.id,
      })
      expect(persistedRunEventJson.join("\n")).not.toContain(
        "private reasoning payload that must never be stored in telemetry",
      )
    } finally {
      composition.closeDatabase()
    }
  })

  test("records replay telemetry without persisting reasoning payload text", async () => {
    const harness = await createHarness("trace-replay-failfast", false)
    seedCompletedAssistantReasoningRun({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_trace_replay_reasoning_history",
      reasoningText: "private reasoning payload that must never be stored in telemetry",
    })
    seedLegacyAssistantToolReplayRun({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_trace_replay_legacy_history",
    })

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_replay_failfast",
      messageId: "message_trace_replay_failfast",
      prompt: "Continue the Kimi session.",
    })
    let providerInvocationCount = 0
    const provider: OrchestrationModelPort = createOrchestrationModelPort(createModelProvider({
      observer: harness.observability.modelObserver,
      replayGuard: {
        providerFamily: "kimi",
        model: "kimi-k2.6",
        requiredReasoningField: "reasoning_content",
      },
      runtime: createModelRuntimeApi({
        async *streamTurn() {
          providerInvocationCount += 1
          yield { type: "text.delta", text: "Provider should never be called." }
        },
      }),
    }))
    const runtime = createRuntime({
      provider,
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      thinking: {
        enabled: true,
      },
      telemetry: {
        capabilityResolution: {
          model: "kimi-k2.6",
          provider: "openai-compatible",
          providerFamily: "kimi",
          catalogSource: "models.dev",
          catalogMiss: false,
          reasoningSource: "models.dev",
          toolCallSource: "models.dev",
          interleavedSource: "models.dev",
          interleavedField: "reasoning_content",
          reasoningEffortSource: "models.dev",
          thinkingSource: "config",
          thinkingEffortSource: "config",
        },
        contextWindow: {
          contextWindow: 65_536,
          source: "/models",
        },
        modelClassification: {
          model: "kimi-k2.6",
          providerFamily: "kimi",
        },
      },
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    expect(providerInvocationCount).toBe(1)

    const trace = harness.observability.exportRunTrace(started.run.id)
    expect(trace).not.toBeNull()
    const eventTypes = readEventTypes(trace?.events ?? [])
    expect(eventTypes).toContain("model.turn.requested")
    expect(eventTypes).toContain("model.prompt.assembled")
    expect(eventTypes).toContain("run.completed")
    expect(eventTypes).not.toContain("replay.fail_fast.blocked")
    expect(eventTypes).not.toContain("error.classified")

    const firstProviderTelemetryIndex = (trace?.events ?? []).findIndex(
      (event) => event.source === "model" && event.eventType === "model.turn.requested",
    )
    const completedIndex = (trace?.events ?? []).findIndex((event) => event.eventType === "run.completed")
    expect(firstProviderTelemetryIndex).toBeGreaterThanOrEqual(0)
    expect(completedIndex).toBeGreaterThan(firstProviderTelemetryIndex)
    expect(trace?.events.find((event) => event.eventType === "kimi.run.classified")?.data).toEqual({
      model: "kimi-k2.6",
      outcome: "success",
    })

    const persistedRunEventJson = harness.database
      .query(`SELECT data_json FROM run_event WHERE run_id = ? ORDER BY sequence ASC`)
      .all(started.run.id) as Array<{ data_json: string }>
    expect(persistedRunEventJson.map((row) => row.data_json).join("\n")).not.toContain(
      "private reasoning payload that must never be stored in telemetry",
    )
  })

  test("does not block replay when prior assistant history contains reasoning but no legacy tool-call replay", async () => {
    const harness = await createHarness("trace-legacy-replay-fixture", false)
    seedCompletedAssistantReasoningRun({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_trace_legacy_reasoning_history",
      reasoningText: "Need to inspect the README before calling read.",
    })

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_legacy_replay",
      messageId: "message_trace_legacy_replay",
      prompt: "Continue the Kimi session.",
    })

    let providerInvocationCount = 0
    const provider: OrchestrationModelPort = createOrchestrationModelPort(createModelProvider({
      observer: harness.observability.modelObserver,
      replayGuard: {
        providerFamily: "kimi",
        model: "kimi-k2.6",
        requiredReasoningField: "reasoning_content",
      },
      runtime: createModelRuntimeApi({
        async *streamTurn() {
          providerInvocationCount += 1
          yield { type: "text.delta", text: "Provider should never be called." }
        },
      }),
    }))

    const runtime = createRuntime({
      provider,
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      thinking: {
        enabled: true,
      },
      telemetry: {
        capabilityResolution: {
          model: "kimi-k2.6",
          provider: "openai-compatible",
          providerFamily: "kimi",
          catalogSource: "models.dev",
          catalogMiss: false,
          reasoningSource: "models.dev",
          toolCallSource: "models.dev",
          interleavedSource: "models.dev",
          interleavedField: "reasoning_content",
          reasoningEffortSource: "models.dev",
          thinkingSource: "config",
          thinkingEffortSource: "config",
        },
        contextWindow: {
          contextWindow: 65_536,
          source: "/models",
        },
        modelClassification: {
          model: "kimi-k2.6",
          providerFamily: "kimi",
        },
      },
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    expect(providerInvocationCount).toBe(1)

    const trace = harness.observability.exportRunTrace(started.run.id)
    expect(trace).not.toBeNull()
    expect(readEventTypes(trace?.events ?? [])).not.toContain("replay.fail_fast.blocked")
    expect(readEventTypes(trace?.events ?? [])).toContain("model.turn.requested")
  })

  test("continue-without-thinking disables thinking for later turns in the same session until restored", async () => {
    const harness = await createHarness("trace-session-thinking-override", false)
    seedLegacyAssistantToolReplayRun({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_trace_session_override_legacy_history",
    })

    const seenThinking: Array<boolean | undefined> = []
    let providerInvocationCount = 0
    const provider: OrchestrationModelPort = createOrchestrationModelPort(createModelProvider({
      observer: harness.observability.modelObserver,
      replayGuard: {
        providerFamily: "kimi",
        model: "kimi-k2.6",
        requiredReasoningField: "reasoning_content",
      },
      runtime: createModelRuntimeApi({
        async *streamTurn(request: ProviderTurnRequest) {
          providerInvocationCount += 1
          seenThinking.push(request.thinking?.enabled)
          yield { type: "text.delta", text: `thinking=${String(request.thinking?.enabled)}` }
        },
      }),
    }))

    const runtime = createRuntime({
      provider,
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      thinking: {
        enabled: true,
      },
      telemetry: {
        capabilityResolution: {
          model: "kimi-k2.6",
          provider: "openai-compatible",
          providerFamily: "kimi",
          catalogSource: "models.dev",
          catalogMiss: false,
          reasoningSource: "models.dev",
          toolCallSource: "models.dev",
          interleavedSource: "models.dev",
          interleavedField: "reasoning_content",
          reasoningEffortSource: "models.dev",
          thinkingSource: "config",
          thinkingEffortSource: "config",
        },
        contextWindow: {
          contextWindow: 65_536,
          source: "/models",
        },
        modelClassification: {
          model: "kimi-k2.6",
          providerFamily: "kimi",
        },
      },
      now: harness.now,
    })

    const first = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_session_override_first",
      messageId: "message_trace_session_override_first",
      prompt: "Continue the legacy Kimi session.",
    })
    const firstHandle = await runtime.run({
      sessionId: harness.session.id,
      runId: first.run.id,
    })
    await collectEvents(firstHandle.events)

    expect(providerInvocationCount).toBe(1)
    expect(readEventTypes(harness.observability.exportRunTrace(first.run.id)?.events ?? [])).toEqual(
      expect.arrayContaining(["model.turn.requested", "model.prompt.assembled", "run.completed"]),
    )
    expect(readEventTypes(harness.observability.exportRunTrace(first.run.id)?.events ?? [])).not.toContain(
      "replay.fail_fast.blocked",
    )

    runtime.setSessionThinkingOverride({
      sessionId: harness.session.id,
      thinking: { enabled: false },
    })

    const second = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_session_override_second",
      messageId: "message_trace_session_override_second",
      prompt: "Keep going without thinking.",
    })
    const secondHandle = await runtime.run({
      sessionId: harness.session.id,
      runId: second.run.id,
    })
    await collectEvents(secondHandle.events)

    expect(providerInvocationCount).toBe(2)
    expect(seenThinking).toEqual([true, false])
    expect(readEventTypes(harness.observability.exportRunTrace(second.run.id)?.events ?? [])).not.toContain(
      "replay.fail_fast.blocked",
    )

    runtime.setSessionThinkingOverride({
      sessionId: harness.session.id,
      thinking: null,
    })

    const third = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_trace_session_override_third",
      messageId: "message_trace_session_override_third",
      prompt: "Thinking should be restored.",
    })
    const thirdHandle = await runtime.run({
      sessionId: harness.session.id,
      runId: third.run.id,
    })
    await collectEvents(thirdHandle.events)

    expect(providerInvocationCount).toBe(3)
    expect(seenThinking).toEqual([true, false, true])
    expect(readEventTypes(harness.observability.exportRunTrace(third.run.id)?.events ?? [])).toEqual(
      expect.arrayContaining(["model.turn.requested", "model.prompt.assembled", "run.completed"]),
    )
    expect(readEventTypes(harness.observability.exportRunTrace(third.run.id)?.events ?? [])).not.toContain(
      "replay.fail_fast.blocked",
    )
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

function closeTrackedDatabase(database: { close: (throwOnError: boolean) => void }) {
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

function seedCompletedAssistantReasoningRun(input: {
  repository: SessionRepository
  sessionId: string
  runId: string
  reasoningText: string
}) {
  input.repository.runs.create({
    id: input.runId,
    sessionId: input.sessionId,
    trigger: "prompt",
    status: "completed",
  })
  const assistantMessage = input.repository.messages.create({
    id: `${input.runId}_assistant`,
    sessionId: input.sessionId,
    runId: input.runId,
    role: "assistant",
    sequence: 0,
  })

  input.repository.parts.create({
    id: `${input.runId}_reasoning_part`,
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: assistantMessage.id,
    kind: "reasoning",
    sequence: 0,
    text: input.reasoningText,
  })
}

function seedLegacyAssistantToolReplayRun(input: {
  repository: SessionRepository
  sessionId: string
  runId: string
}) {
  input.repository.runs.create({
    id: input.runId,
    sessionId: input.sessionId,
    trigger: "prompt",
    status: "completed",
  })
  const assistantMessage = input.repository.messages.create({
    id: `${input.runId}_assistant`,
    sessionId: input.sessionId,
    runId: input.runId,
    role: "assistant",
    sequence: 0,
  })

  input.repository.parts.create({
    id: `${input.runId}_tool_call_part`,
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: assistantMessage.id,
    kind: "tool_call",
    sequence: 0,
    text: '{"path":"README.md"}',
    data: {
      callId: "call_legacy_read",
      toolName: "read",
      inputText: '{"path":"README.md"}',
    },
  })
  input.repository.parts.create({
    id: `${input.runId}_tool_result_part`,
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: assistantMessage.id,
    kind: "tool_result",
    sequence: 1,
    text: "L1#5ce914f5|README contents",
    data: {
      callId: "call_legacy_read",
      toolName: "read",
      output: "L1#5ce914f5|README contents",
    },
  })
}

function readPersistedRunEventJson(input: { databasePath: string; runId: string }) {
  const database = openSessionDatabase(input.databasePath)

  try {
    const rows = database
      .query(`SELECT data_json FROM run_event WHERE run_id = ? ORDER BY sequence ASC`)
      .all(input.runId) as Array<{ data_json: string }>
    return rows.map((row) => row.data_json)
  } finally {
    database.close(false)
  }
}

function createProtocolTelemetryFixture() {
  return {
    capabilityResolution: {
      model: "deepseek-reasoner",
      provider: "openai-compatible" as const,
      providerFamily: "generic" as const,
      catalogSource: "models.dev" as const,
      catalogMiss: false,
      reasoningSource: "models.dev" as const,
      toolCallSource: "models.dev" as const,
      interleavedSource: "models.dev" as const,
      interleavedField: "reasoning_content" as const,
      reasoningEffortSource: "models.dev" as const,
      thinkingSource: "models.dev" as const,
      thinkingEffortSource: "models.dev" as const,
    },
    contextWindow: {
      contextWindow: 131_072,
      source: "models.dev" as const,
    },
    modelClassification: {
      model: "deepseek-reasoner",
      providerFamily: "generic" as const,
    },
  } as const
}

function assertSubagentProtocolTelemetryBaseline(input: {
  parentRunId: string
  childRun: ReturnType<SessionRepository["runs"]["listBySession"]>[number]
  parentTraceEvents: StoredRunEvent[]
  childTraceEvents: StoredRunEvent[]
  parentTimeline: ReturnType<SessionRepository["messages"]["listSessionTimeline"]>
  childTimeline: ReturnType<SessionRepository["messages"]["listSessionTimeline"]>
  parentAgentCallId: string
  childPrompt: string
  childReasoning: string
  childOutput: string
  childAllowedToolNames: string[]
  expectedProvider: string
  expectedModel: string
}) {
  expect(input.childRun.parentRunId).toBe(input.parentRunId)
  expect(input.childRun.status).toBe("completed")

  const parentEventTypes = readEventTypes(input.parentTraceEvents)
  const childEventTypes = readEventTypes(input.childTraceEvents)
  expect(parentEventTypes).toEqual(expect.arrayContaining([
    "model.turn.requested",
    "model.prompt.assembled",
    "tool.call.completed",
    "run.completed",
  ]))
  expect(childEventTypes).toEqual(expect.arrayContaining([
    "run.started",
    "subagent.started",
    "model.turn.requested",
    "model.prompt.assembled",
    "subagent.completed",
    "run.completed",
  ]))
  expect(childEventTypes).not.toContain("subagent.failed")
  expect([...parentEventTypes, ...childEventTypes]).not.toContain("error.classified")
  expect([...parentEventTypes, ...childEventTypes]).not.toContain("credential.rotated")

  expect(input.parentTraceEvents.find((event) => event.eventType === "capability.resolution.recorded")?.data)
    .toMatchObject({
      provider: input.expectedProvider,
      model: input.expectedModel,
      catalogMiss: false,
      catalogSource: "models.dev",
      interleavedField: "reasoning_content",
    })
  const parentPromptEvent = input.parentTraceEvents.find(
    (event) =>
      event.source === "model" &&
      event.eventType === "model.prompt.assembled" &&
      typeof event.data.systemPromptLength === "number",
  )
  expect(parentPromptEvent).toBeDefined()
  if (!parentPromptEvent) {
    return
  }
  expect(parentPromptEvent.data.systemPromptHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/))
  expect(typeof parentPromptEvent.data.systemPromptLength).toBe("number")
  expect(parentPromptEvent.data.systemPromptLength as number).toBeGreaterThan(0)
  const childModelRequest = input.childTraceEvents.find((event) => event.eventType === "model.turn.requested")
  expect(childModelRequest?.data).toMatchObject({
    toolNames: expect.arrayContaining([
      "read",
      "grep",
      "glob",
      "webfetch",
      "websearch",
      "get_current_datetime",
    ]),
    toolCount: expect.any(Number),
  })

  expect(input.childTraceEvents.find((event) => event.eventType === "subagent.started")?.data)
    .toMatchObject({
      agentId: "source-researcher",
      displayName: "Source Researcher",
      status: "started",
      parentRunId: input.parentRunId,
      subRunId: input.childRun.id,
    })
  expect(input.childTraceEvents.find((event) => event.eventType === "subagent.completed")?.data)
    .toMatchObject({
      agentId: "source-researcher",
      displayName: "Source Researcher",
      status: "completed",
      parentRunId: input.parentRunId,
      subRunId: input.childRun.id,
      outputLength: input.childOutput.length,
    })

  expect(input.childAllowedToolNames).toEqual(expect.arrayContaining([
    "read",
    "grep",
    "glob",
    "webfetch",
    "websearch",
    "get_current_datetime",
  ]))
  expect(input.childAllowedToolNames).not.toContain("agent")
  expect(input.childAllowedToolNames).not.toContain("shell")
  expect(input.childAllowedToolNames).not.toContain("write")

  const parentAgentResult = input.parentTimeline
    .flatMap((message) => message.parts)
    .find(
      (part) =>
        part.kind === "tool_result" &&
        (part.data as { callId?: string } | undefined)?.callId === input.parentAgentCallId,
    )
  expect(parentAgentResult).toMatchObject({
    kind: "tool_result",
    text: input.childOutput,
    data: expect.objectContaining({
      callId: input.parentAgentCallId,
      toolName: "agent",
      output: input.childOutput,
    }),
  })

  const childText = input.childTimeline
    .flatMap((message) => message.parts)
    .map((part) => part.text ?? "")
    .join("\n")
  const parentText = input.parentTimeline
    .flatMap((message) => message.parts)
    .map((part) => part.text ?? "")
    .join("\n")
  const childReasoningPart = input.childTimeline
    .flatMap((message) => message.parts)
    .find((part) => part.kind === "reasoning")
  expect(childText).toContain(input.childPrompt)
  expect(childText).toContain(input.childOutput)
  expect(childReasoningPart).toMatchObject({
    kind: "reasoning",
    text: input.childReasoning,
  })
  expect(parentText).toContain(input.childOutput)
  expect(parentText).not.toContain(input.childReasoning)
  expect(readVisibleTimelineText(input.parentTimeline)).not.toContain(input.childReasoning)
  expect(readVisibleTimelineText(input.childTimeline)).not.toContain(input.childReasoning)
}

type OpenAICompatibleRequest = OpenAI.Chat.ChatCompletionCreateParamsStreaming
type OpenAICompatibleCreate = (
  body: OpenAICompatibleRequest,
  options?: OpenAI.RequestOptions,
) =>
  | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
  | Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>

function createMockOpenAICompatibleClient(create: OpenAICompatibleCreate): OpenAI {
  return {
    chat: {
      completions: {
        create: create as OpenAI["chat"]["completions"]["create"],
      },
    },
  } as OpenAI
}

function createOpenAICompatibleChunk(
  partial: Record<string, unknown>,
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null = null,
): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: "chatcmpl_subagent_reasoning_fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-reasoner",
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        delta: partial,
      },
    ],
  } as OpenAI.Chat.ChatCompletionChunk
}

function createOpenAICompatibleToolCallChunk(input: {
  index: number
  id: string
  name: string
  argumentsText: string
}) {
  return {
    index: input.index,
    id: input.id,
    type: "function" as const,
    function: {
      name: input.name,
      arguments: input.argumentsText,
    },
  }
}

function readAssistantReplayWithToolCalls(body: unknown): Record<string, unknown> | undefined {
  const messages = (body as { messages?: unknown[] } | null | undefined)?.messages
  return messages?.find(
    (message): message is Record<string, unknown> =>
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "assistant" &&
      Array.isArray((message as { tool_calls?: unknown }).tool_calls),
  )
}

function readVisibleTimelineText(
  timeline: ReturnType<SessionRepository["messages"]["listSessionTimeline"]>,
) {
  return timeline
    .flatMap((message) => message.parts)
    .filter((part) => part.kind !== "reasoning")
    .map((part) => part.text ?? "")
    .join("\n")
}

function createTurnProvider(
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
  observer?: ReturnType<typeof createObservabilityRuntimeApi>["modelObserver"],
): OrchestrationModelPort {
  let index = 0

  return createOrchestrationModelPort(createModelProvider({
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
  }))
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
