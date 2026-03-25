import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createCliRuntime,
  type CreateRunEventInput,
  type ObservabilityRepository,
  type StoredRunEvent,
} from "../src/bootstrap"
import {
  createModelProvider,
  createModelRuntimeApi,
} from "../src/model"

describe("bootstrap runtime", () => {
  test("createCliRuntime uses an injected observability repository for runtime traces", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "bootstrap-runtime-observability-"))
    const observabilityRepository = createRecordingObservabilityRepository()

    try {
      const runtime = createCliRuntime({
        provider: createTextProvider("Observed output."),
        observabilityRepository: observabilityRepository.repository,
      })

      const handle = await runtime.run({
        cwd: workspaceRoot,
        workspaceRoot,
        prompt: "Say hello",
      })
      await collectEvents(handle.events)

      expect(
        observabilityRepository.events.map((event) => event.eventType),
      ).toEqual(
        expect.arrayContaining([
          "run.started",
          "tool.listed",
          "message.started",
          "message.delta",
          "run.completed",
        ]),
      )
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true })
    }
  })

  test("createCliRuntime forwards the custom observability repository factory", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "bootstrap-runtime-observability-factory-"))
    const observabilityRepository = createRecordingObservabilityRepository()
    let factoryCalls = 0

    try {
      const runtime = createCliRuntime({
        provider: createTextProvider("Observed output."),
        createObservabilityRepositoryImpl() {
          factoryCalls += 1
          return observabilityRepository.repository
        },
      })

      const handle = await runtime.run({
        cwd: workspaceRoot,
        workspaceRoot,
        prompt: "Say hello",
      })
      await collectEvents(handle.events)

      expect(factoryCalls).toBe(1)
      expect(
        observabilityRepository.events.map((event) => event.eventType),
      ).toContain("run.completed")
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true })
    }
  })
})

function createTextProvider(text: string) {
  return createModelProvider({
    runtime: createModelRuntimeApi({
      async *streamTurn() {
        yield {
          type: "text.delta" as const,
          text,
        }
      },
    }),
  })
}

function createRecordingObservabilityRepository(): {
  repository: ObservabilityRepository
  events: StoredRunEvent[]
} {
  const events: StoredRunEvent[] = []

  return {
    repository: {
      runEvents: {
        append(input: CreateRunEventInput) {
          const record: StoredRunEvent = {
            id: input.id ?? `event_${events.length + 1}`,
            sessionId: input.sessionId,
            runId: input.runId,
            sequence: events.filter((event) => event.runId === input.runId).length,
            source: input.source,
            eventType: input.eventType,
            data: input.data ?? {},
            createdAt: input.createdAt ?? 0,
          }
          events.push(record)
          return record
        },
        listByRun(runId: string) {
          return events.filter((event) => event.runId === runId)
        },
      },
    },
    events,
  }
}

async function collectEvents(events: AsyncIterable<unknown>) {
  const collected: unknown[] = []

  for await (const event of events) {
    collected.push(event)
  }

  return collected
}
