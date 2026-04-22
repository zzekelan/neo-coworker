import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createCliRuntime,
  createOrchestrationModelPort,
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

  test("createCliRuntime forwards the configured search backend to builtin search tools", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "bootstrap-runtime-search-"))
    const calls: Array<{ toolName: string; query: string }> = []
    let turnIndex = 0

    try {
      const runtime = createCliRuntime({
        provider: createModelProvider({
          runtime: createModelRuntimeApi({
            async *streamTurn() {
              if (turnIndex === 0) {
                turnIndex += 1
                yield {
                  type: "tool.call" as const,
                  callId: "call_websearch",
                  name: "websearch",
                  inputText: '{"query":"bun sqlite docs"}',
                }
                return
              }

              yield {
                type: "text.delta" as const,
                text: "Search complete.",
              }
            },
          }),
        }),
        permissionPolicy: {
          websearch: "allow",
        },
        searchBackend: async (input) => {
          calls.push({
            toolName: input.toolName,
            query: input.query,
          })
          return "docs result"
        },
      })

      const handle = await runtime.run({
        cwd: workspaceRoot,
        workspaceRoot,
        prompt: "Look up Bun sqlite docs",
      })
      await collectEvents(handle.events)

      expect(calls).toEqual([
        {
          toolName: "websearch",
          query: "bun sqlite docs",
        },
      ])
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true })
    }
  })

  test("createOrchestrationModelPort forwards reasoning deltas from the model provider", async () => {
    const model = createOrchestrationModelPort(createModelProvider({
      runtime: createModelRuntimeApi({
        async *streamTurn() {
          yield {
            type: "reasoning.delta" as const,
            text: "Need to inspect the README first.",
          }
        },
      }),
    }))

    const events = []
    for await (const event of model.streamTurn({
      systemPrompt: "system",
      skillCatalog: [],
      activeSkills: [],
      tools: [],
      transcript: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual(expect.arrayContaining([
      {
        type: "reasoning.delta",
        text: "Need to inspect the README first.",
      },
    ]))
  })

  test("createOrchestrationModelPort forwards session thinking override controls to the model provider", () => {
    const calls: string[] = []
    const model = createOrchestrationModelPort({
      projectTurn() {
        return { inputTokens: 0 }
      },
      async *streamTurn() {
        return
      },
      continueWithoutThinking(input) {
        calls.push(`disable:${input.sessionId}`)
      },
      restoreThinking(input) {
        calls.push(`enable:${input.sessionId}`)
      },
    })

    model.continueWithoutThinking?.({ sessionId: "session_1" })
    model.restoreThinking?.({ sessionId: "session_1" })

    expect(calls).toEqual(["disable:session_1", "enable:session_1"])
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
