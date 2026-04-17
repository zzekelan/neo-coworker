import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRuntime } from "../../src/bootstrap"
import { createObservabilityRepository, createObservabilityRuntimeApi } from "../../src/observability"
import { createPermissionRepository } from "../../src/permission"
import {
  createSessionRepository,
  createSessionRunService,
  openSessionDatabase,
} from "../../src/session"
import {
  createModelProvider,
  createModelRuntimeApi,
  type ProviderEvent,
  type ProviderTurnRequest,
} from "../../src/model"

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

describe("integration: bootstrap parallelization wiring", () => {
  test("uses ParallelExecutor for read-only tool batches while preserving result order", async () => {
    const harness = await createHarness("parallelization")
    await writeFile(join(harness.workspaceRoot, "alpha.txt"), "alpha\n", "utf8")
    await writeFile(join(harness.workspaceRoot, "beta.txt"), "beta\n", "utf8")
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_parallelization",
      messageId: "message_parallelization",
      prompt: "Read alpha and glob txt files",
    })

    const runtime = createRuntime({
      provider: createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read_alpha",
            name: "read",
            inputText: JSON.stringify({ path: "alpha.txt" }),
          }
          yield {
            type: "tool.call",
            callId: "call_glob_txt",
            name: "glob",
            inputText: JSON.stringify({ pattern: "**/*.txt" }),
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Done." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      now: harness.now,
    })

    const handle = await runtime.run({ sessionId: harness.session.id, runId: started.run.id })
    await collectEvents(handle.events)

    const trace = harness.observability.exportRunTrace(started.run.id)
    const toolEvents = trace?.events.filter((event) => event.source === "tool") ?? []
    expect(toolEvents.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "parallel.plan_generated",
      "parallel.batch_started",
      "parallel.batch_completed",
    ]))

    const planEvent = toolEvents.find((event) => event.eventType === "parallel.plan_generated")
    expect(planEvent?.data).toEqual({
      payload: {
        totalCalls: 2,
        batchCount: 1,
        maxBatchSize: 2,
      },
    })

    const batchStartedEvent = toolEvents.find((event) => event.eventType === "parallel.batch_started")
    expect(batchStartedEvent?.data).toEqual({
      payload: {
        batchIndex: 0,
        callCount: 2,
        toolNames: ["read", "glob"],
      },
    })

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const toolResults = transcript
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "tool_result")

    expect(toolResults).toHaveLength(2)
    expect(toolResults.map((part) => (part.data as { callId?: string }).callId)).toEqual([
      "call_read_alpha",
      "call_glob_txt",
    ])
    expect(toolResults[0]?.text).toContain("1: alpha")
    expect(toolResults[1]?.text).toContain("alpha.txt")
    expect(toolResults[1]?.text).toContain("beta.txt")
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
) {
  let index = 0

  return createModelProvider({
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
