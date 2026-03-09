import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionRunService } from "../../src/session"
import { createStorageRepository, openStorageDatabase, type StorageRepository } from "../../src/storage"
import { buildTranscriptMessages } from "../../src/runtime/context"
import { createRuntime } from "../../src/runtime/runtime"
import type { Provider, ProviderEvent, ProviderTurnRequest } from "../../src/providers/types"

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

describe("agent loop", () => {
  test("reads prior transcript, roundtrips tool results, and completes the same run", async () => {
    const harness = await createHarness("single-roundtrip", true)
    seedCompletedRun({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_history",
      userText: "What happened before?",
      assistantText: "Earlier assistant context.",
    })
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_active",
      messageId: "message_active_user",
      prompt: "Inspect README.md",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield { type: "text.delta", text: "Looking at the file." }
          yield {
            type: "tool.call",
            callId: "call_1",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Summary complete." }
        },
      ]),
      repository: harness.repository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)
    const requestContents = requests.map(readRequestContents)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(requestContents[0]?.join("\n")).toContain("Earlier assistant context.")
    expect(requestContents[0]?.join("\n")).toContain("Inspect README.md")
    expect(requestContents[1]?.join("\n")).toContain("Tool result read (call_1)")
    expect(requestContents[1]?.join("\n")).toContain("# demo workspace")
    expect(activeRunMessages).toHaveLength(3)
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual([
      "text",
      "tool_call",
      "tool_result",
    ])
    expect(activeRunMessages[1]?.parts[2]).toMatchObject({
      kind: "tool_result",
      text: "# demo workspace\n\nThis fixture exists for the read-only tool tests.\n",
      data: {
        callId: "call_1",
        toolName: "read",
        output: "# demo workspace\n\nThis fixture exists for the read-only tool tests.\n",
      },
    })
    expect(activeRunMessages[2]?.parts).toMatchObject([{ kind: "text", text: "Summary complete." }])
    expect(events.map((event) => event.type)).toContain("tool.call.completed")
    expect(events.at(-1)).toMatchObject({ type: "run.completed", runId: started.run.id })
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("supports multiple model and tool cycles inside one durable run", async () => {
    const harness = await createHarness("multi-cycle", true)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_multi",
      messageId: "message_multi_user",
      prompt: "Inspect the fixture twice",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_search",
            name: "search",
            inputText: '{"query":"fixture"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Two checks complete." }
        },
      ]),
      repository: harness.repository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(requests).toHaveLength(3)
    expect(readRequestContents(requests[1]!).join("\n")).toContain("Tool result read (call_read)")
    expect(readRequestContents(requests[2]!).join("\n")).toContain("Tool result search (call_search)")
    expect(activeRunMessages).toHaveLength(4)
    expect(
      activeRunMessages.flatMap((message) => message.parts.filter((part) => part.kind === "tool_result")),
    ).toHaveLength(2)
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("persists malformed tool arguments as an error outcome and continues the run", async () => {
    const harness = await createHarness("tool-error", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_tool_error",
      messageId: "message_tool_error_user",
      prompt: "Try a bad tool call",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_bad",
            name: "read",
            inputText: '{"path":',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Recovered after bad args." }
        },
      ]),
      repository: harness.repository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(readRequestContents(requests[1]!).join("\n")).toContain("Malformed tool arguments for read")
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual(["tool_call", "error"])
    expect(activeRunMessages[1]?.parts[1]).toMatchObject({
      kind: "error",
      text: expect.stringContaining("Malformed tool arguments for read"),
    })
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("persists provider failures and marks the run failed", async () => {
    const harness = await createHarness("provider-failure", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_provider_failure",
      messageId: "message_provider_failure_user",
      prompt: "Trigger a provider error",
    })
    const runtime = createRuntime({
      provider: {
        async *streamTurn() {
          yield { type: "text.delta", text: "Starting." }
          throw new Error("provider exploded")
        },
      },
      repository: harness.repository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual(["text", "error"])
    expect(activeRunMessages[1]?.parts[1]).toMatchObject({
      kind: "error",
      text: "provider exploded",
      data: { source: "provider" },
    })
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      runId: started.run.id,
      error: "provider exploded",
    })
    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      status: "failed",
      errorText: "provider exploded",
    })
  })

  test("cancellation keeps persisted output intact and marks the run cancelled", async () => {
    const harness = await createHarness("cancelled", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_cancelled",
      messageId: "message_cancelled_user",
      prompt: "Start and then cancel",
    })
    const runtime = createRuntime({
      provider: {
        async *streamTurn(request: ProviderTurnRequest) {
          yield { type: "text.delta", text: "Partial output." }
          await new Promise<void>((_, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted")
                error.name = "AbortError"
                reject(error)
              },
              { once: true },
            )
          })
        },
      },
      repository: harness.repository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const observedTypes: string[] = []

    while (true) {
      const next = await iterator.next()
      if (next.done) {
        break
      }

      observedTypes.push(next.value.type)
      if (next.value.type === "message.delta") {
        handle.cancel()
      }
    }

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(observedTypes.at(-1)).toBe("run.cancelled")
    expect(activeRunMessages[1]?.parts).toMatchObject([{ kind: "text", text: "Partial output." }])
    expect(harness.repository.runs.get(started.run.id).status).toBe("cancelled")
  })

  test("reloads already persisted assistant output from storage while the run is still active", async () => {
    const harness = await createHarness("reload", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_reload",
      messageId: "message_reload_user",
      prompt: "Write partial output",
    })
    let releaseStream!: () => void
    const streamBlocked = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const runtime = createRuntime({
      provider: {
        async *streamTurn() {
          yield { type: "text.delta", text: "Already persisted." }
          await streamBlocked
        },
      },
      repository: harness.repository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()

    while (true) {
      const next = await iterator.next()
      if (next.done) {
        throw new Error("expected partial output before the stream closed")
      }

      if (next.value.type === "message.delta") {
        const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
        const reconstructed = buildTranscriptMessages(transcript)
        expect(reconstructed.map((message) => message.content)).toContain("Already persisted.")
        expect(harness.repository.runs.get(started.run.id).status).toBe("running")
        handle.cancel()
        releaseStream()
        break
      }
    }

    const remainingTypes: string[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done) {
        break
      }
      remainingTypes.push(next.value.type)
    }

    expect(remainingTypes.at(-1)).toBe("run.cancelled")
  })
})

async function createHarness(prefix: string, withFixtureWorkspace: boolean) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  if (withFixtureWorkspace) {
    await cp("test/fixtures/workspaces/read-search", workspaceRoot, { recursive: true })
  } else {
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")
  }

  const now = createMonotonicClock()
  const database = trackDatabase(openStorageDatabase(join(directory, "agent.sqlite")))
  const repository = createStorageRepository({
    database,
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
    repository,
    service,
    session,
    workspaceRoot,
    now,
  }
}

function startPromptRun(input: {
  repository: StorageRepository
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

function seedCompletedRun(input: {
  repository: StorageRepository
  sessionId: string
  runId: string
  userText: string
  assistantText: string
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
    text: input.userText,
  })
  const assistantMessage = input.repository.messages.create({
    id: `${input.runId}_assistant`,
    sessionId: input.sessionId,
    runId: input.runId,
    role: "assistant",
    sequence: 1,
  })
  input.repository.parts.create({
    id: `${input.runId}_assistant_part`,
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: assistantMessage.id,
    kind: "text",
    sequence: 0,
    text: input.assistantText,
  })
}

function createTurnProvider(
  requests: ProviderTurnRequest[],
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
): Provider {
  let index = 0

  return {
    async *streamTurn(request: ProviderTurnRequest) {
      requests.push(request)
      const turn = turns[index]
      index += 1

      if (!turn) {
        throw new Error(`Unexpected provider turn ${index}`)
      }

      for await (const event of turn(request)) {
        yield event
      }
    },
  }
}

async function collectEvents(events: AsyncIterable<unknown>) {
  const collected = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

function readRequestContents(request: ProviderTurnRequest) {
  return ((request.messages as Array<{ content?: string }> | undefined) ?? []).map(
    (message) => message.content ?? "",
  )
}

function createMonotonicClock(start = 1) {
  let current = start
  return () => {
    const value = current
    current += 1
    return value
  }
}

function trackDatabase<T extends { close: (throwOnError: boolean) => void }>(database: T) {
  openDatabases.push(database)
  return database
}
