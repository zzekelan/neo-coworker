import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime } from "../../src/bootstrap"
import { createObservabilityRepository, createObservabilityRuntimeApi } from "../../src/observability"
import { createPermissionRepository } from "../../src/permission"
import { createSessionRepository, createSessionRunService, openSessionDatabase } from "../../src/session"
import { createModelProvider, createModelRuntimeApi, type ProviderEvent, type ProviderTurnRequest } from "../../src/model"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []

afterEach(async () => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true })
  }
})

describe("integration: memory wiring", () => {
  test("wires memory tools, injects a frozen memory snapshot, and records prompt assembly telemetry", async () => {
    const harness = await createHarness("memory-wiring-seeded")
    await mkdir(join(harness.workspaceRoot, ".ncoworker", "memory"), { recursive: true })
    await writeFile(
      join(harness.workspaceRoot, ".ncoworker", "memory", "MEMORY.md"),
      "Use bun test for focused verification.",
    )
    await writeFile(
      join(harness.workspaceRoot, ".ncoworker", "memory", "USER.md"),
      "Prefers concise answers.",
    )

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_memory_wiring_seeded",
      messageId: "message_memory_wiring_seeded",
      prompt: "Continue with saved memory",
    })

    const listedToolNames: string[][] = []
    const seenSystemPrompts: string[] = []
    const runtime = createRuntime({
      provider: createTurnProvider([
        async function* (request) {
          listedToolNames.push(request.tools.map((tool) => tool.name))
          seenSystemPrompts.push(request.system)
          yield { type: "text.delta", text: "Memory loaded." }
        },
      ], harness.observability.modelObserver),
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

    expect(listedToolNames[0]).toEqual(expect.arrayContaining([
      "memory_add",
      "memory_replace",
      "memory_remove",
      "memory_view",
    ]))
    expect(seenSystemPrompts[0]).toContain("MEMORY (your personal notes)")
    expect(seenSystemPrompts[0]).toContain("Use bun test for focused verification.")
    expect(seenSystemPrompts[0]).toContain("USER PROFILE (who the user is)")
    expect(seenSystemPrompts[0]).toContain("Prefers concise answers.")

    const trace = harness.observability.exportRunTrace(started.run.id)
    const promptEvent = trace?.events.find((event) => event.eventType === "prompt.assembled")
    const memoryEvent = trace?.events.find((event) => {
      if (event.source !== "memory" || event.eventType !== "memory.loaded") {
        return false
      }

      const payload = (event.data as { payload?: { target?: string } }).payload
      return payload?.target === "all"
    })

    expect(promptEvent?.source).toBe("orchestration")
    expect(promptEvent?.data).toMatchObject({
      hasMemorySnapshot: true,
      hasSkillReminders: false,
      sections: expect.arrayContaining([
        expect.objectContaining({ name: "identity", charCount: expect.any(Number) }),
        expect.objectContaining({ name: "memory_snapshot", charCount: expect.any(Number) }),
      ]),
    })
    expect((promptEvent?.data as { fullPromptText: string }).fullPromptText).toContain(
      "Use bun test for focused verification.",
    )
    expect((promptEvent?.data as { fullPromptText: string }).fullPromptText).toContain(
      "Prefers concise answers.",
    )
    expect((promptEvent?.data as { totalChars: number }).totalChars).toBe(
      (promptEvent?.data as { fullPromptText: string }).fullPromptText.length,
    )
    expect(memoryEvent?.data).toEqual({
      payload: {
        target: "all",
        entryCount: 2,
        snapshotLength: expect.any(Number),
      },
    })
  })

  test("does not inject empty memory into the prompt", async () => {
    const harness = await createHarness("memory-wiring-empty")
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_memory_wiring_empty",
      messageId: "message_memory_wiring_empty",
      prompt: "Continue without saved memory",
    })

    const seenSystemPrompts: string[] = []
    const runtime = createRuntime({
      provider: createTurnProvider([
        async function* (request) {
          seenSystemPrompts.push(request.system)
          yield { type: "text.delta", text: "No memory loaded." }
        },
      ], harness.observability.modelObserver),
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

    expect(seenSystemPrompts[0]).not.toContain("MEMORY (your personal notes)")
    expect(seenSystemPrompts[0]).not.toContain("USER PROFILE (who the user is)")

    const trace = harness.observability.exportRunTrace(started.run.id)
    const promptEvent = trace?.events.find((event) => event.eventType === "prompt.assembled")
    expect(promptEvent?.data).toMatchObject({
      hasMemorySnapshot: false,
      hasSkillReminders: false,
    })
  })
})

async function createHarness(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  const databasePath = join(directory, "agent.sqlite")
  await mkdir(workspaceRoot, { recursive: true })

  const now = createMonotonicClock()
  const database = openSessionDatabase(databasePath)
  openDatabases.push(database)
  const repository = createSessionRepository({ database, now })
  const permissionRepository = createPermissionRepository({ database, now })
  const observabilityRepository = createObservabilityRepository({ database, now })
  const observability = createObservabilityRuntimeApi({ repository: observabilityRepository, now })
  const service = createSessionRunService({ repository, now })
  const session = repository.sessions.create({
    id: `${prefix}_session`,
    directory: workspaceRoot,
    workspaceRoot,
    createdAt: now(),
  })

  return {
    workspaceRoot,
    repository,
    permissionRepository,
    observability,
    service,
    session,
    now,
  }
}

function startPromptRun(input: {
  repository: ReturnType<typeof createSessionRepository>
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

async function collectEvents(events: AsyncIterable<unknown>) {
  const collected: unknown[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

function createMonotonicClock() {
  let current = 100
  return () => {
    current += 1
    return current
  }
}
