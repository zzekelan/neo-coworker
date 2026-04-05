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
      systemPromptLength: expect.any(Number),
      systemReminderLength: expect.any(Number),
    })
    expect(promptEvents[1]?.data).toMatchObject({
      catalogSkillNames: ["reviewer"],
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
