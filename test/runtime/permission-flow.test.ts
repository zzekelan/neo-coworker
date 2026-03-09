import { afterEach, describe, expect, test } from "bun:test"
import { access, cp, mkdir, mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionRunService } from "../../src/session"
import type { PermissionResponse } from "../../src/runtime/permissions"
import { createRuntime } from "../../src/runtime/runtime"
import { StorageNotFoundError, createStorageRepository, openStorageDatabase, type StorageRepository } from "../../src/storage"
import type { Provider, ProviderEvent, ProviderTurnRequest } from "../../src/providers/types"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []

type RuntimeController = ReturnType<typeof createRuntime> & {
  respondPermission(input: PermissionResponse): void
  cancelRun(runId: string): void
}

afterEach(async () => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("runtime permission flow", () => {
  test("approval resumes the same run after waiting permission", async () => {
    const harness = await createHarness("permission-allow", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_allow",
      messageId: "message_permission_allow_user",
      prompt: "Write notes.txt",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createPermissionRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield { type: "text.delta", text: "Preparing write." }
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Write finished." }
        },
      ]),
      harness,
      permissionPolicy: {
        write: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    expect(permissionEvent.reason).toBe("write notes.txt")
    expect(requests).toHaveLength(1)
    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      id: started.run.id,
      status: "waiting_permission",
    })
    expect(harness.repository.permissionRequests.listByRun(started.run.id)).toMatchObject([
      {
        id: permissionEvent.requestId,
        sessionId: harness.session.id,
        runId: started.run.id,
        toolName: "write",
        status: "pending",
      },
    ])

    runtime.respondPermission({
      requestId: permissionEvent.requestId,
      decision: "allow",
    })

    const remainingEvents = await collectEvents(iterator)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(await readFile(join(harness.workspaceRoot, "notes.txt"), "utf8")).toBe("hello")
    expect(requests).toHaveLength(2)
    expect(activeRunMessages).toHaveLength(3)
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual([
      "text",
      "tool_call",
      "tool_result",
    ])
    expect(activeRunMessages[2]?.parts).toMatchObject([{ kind: "text", text: "Write finished." }])
    expect(remainingEvents.at(-1)).toMatchObject({
      type: "run.completed",
      runId: started.run.id,
    })
    expect(harness.repository.permissionRequests.get(permissionEvent.requestId)).toMatchObject({
      id: permissionEvent.requestId,
      status: "approved",
    })
    expect(harness.repository.runs.listBySession(harness.session.id)).toHaveLength(1)
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("denial does not execute the tool side effect", async () => {
    const harness = await createHarness("permission-deny", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_deny",
      messageId: "message_permission_deny_user",
      prompt: "Try to write notes.txt and recover",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createPermissionRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield { type: "text.delta", text: "Trying to write notes.txt." }
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Permission denial handled." }
        },
      ]),
      harness,
      permissionPolicy: {
        write: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    runtime.respondPermission({
      requestId: permissionEvent.requestId,
      decision: "deny",
    })

    await collectEvents(iterator)

    expect(await fileExists(join(harness.workspaceRoot, "notes.txt"))).toBe(false)
    expect(requests).toHaveLength(2)
    expect(harness.repository.permissionRequests.get(permissionEvent.requestId)).toMatchObject({
      id: permissionEvent.requestId,
      status: "denied",
    })
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("duplicate approval does not execute the tool twice", async () => {
    const harness = await createHarness("permission-duplicate", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_duplicate",
      messageId: "message_permission_duplicate_user",
      prompt: "Append once to counter.txt",
    })
    const runtime = createPermissionRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_shell",
            name: "shell",
            inputText: `{"command":"printf '1' >> counter.txt"}`,
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Counter updated." }
        },
      ]),
      harness,
      permissionPolicy: {
        shell: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    runtime.respondPermission({
      requestId: permissionEvent.requestId,
      decision: "allow",
    })

    expect(() =>
      runtime.respondPermission({
        requestId: permissionEvent.requestId,
        decision: "allow",
      }),
    ).toThrow(/not pending/i)

    await collectEvents(iterator)

    expect(await readFile(join(harness.workspaceRoot, "counter.txt"), "utf8")).toBe("1")
    expect(harness.repository.permissionRequests.get(permissionEvent.requestId)).toMatchObject({
      id: permissionEvent.requestId,
      status: "approved",
    })
  })

  test("cancellation while waiting finalizes the request and run", async () => {
    const harness = await createHarness("permission-cancel", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_cancel",
      messageId: "message_permission_cancel_user",
      prompt: "Try to write notes.txt",
    })
    const runtime = createPermissionRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello"}',
          }
        },
      ]),
      harness,
      permissionPolicy: {
        write: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    runtime.cancelRun(started.run.id)

    const remainingEvents = await collectEvents(iterator)

    expect(remainingEvents.at(-1)).toMatchObject({
      type: "run.cancelled",
      runId: started.run.id,
    })
    expect(await fileExists(join(harness.workspaceRoot, "notes.txt"))).toBe(false)
    expect(harness.repository.permissionRequests.get(permissionEvent.requestId)).toMatchObject({
      id: permissionEvent.requestId,
      status: "cancelled",
      resolvedAt: expect.any(Number),
    })
    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      id: started.run.id,
      status: "cancelled",
      finishedAt: expect.any(Number),
    })
    expect(() =>
      runtime.respondPermission({
        requestId: permissionEvent.requestId,
        decision: "allow",
      }),
    ).toThrow(/not pending|cancelled/i)
  })

  test("permission request ids stay unique across approval-gated runs", async () => {
    const harness = await createHarness("permission-unique", false)
    const runtime = createPermissionRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_1",
            name: "write",
            inputText: '{"path":"first.txt","content":"first"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "First done." }
        },
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_2",
            name: "write",
            inputText: '{"path":"second.txt","content":"second"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Second done." }
        },
      ]),
      harness,
      permissionPolicy: {
        write: "ask",
      },
    })

    const firstRun = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_unique_1",
      messageId: "message_permission_unique_1_user",
      prompt: "Write first.txt",
    })
    const firstHandle = await runtime.run({
      sessionId: harness.session.id,
      runId: firstRun.run.id,
    })
    const firstIterator = firstHandle.events[Symbol.asyncIterator]()
    const firstPermission = await waitForPermissionRequest(firstIterator)

    runtime.respondPermission({
      requestId: firstPermission.requestId,
      decision: "allow",
    })
    await collectEvents(firstIterator)

    const secondRun = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_unique_2",
      messageId: "message_permission_unique_2_user",
      prompt: "Write second.txt",
    })
    const secondHandle = await runtime.run({
      sessionId: harness.session.id,
      runId: secondRun.run.id,
    })
    const secondIterator = secondHandle.events[Symbol.asyncIterator]()
    const secondPermission = await waitForPermissionRequest(secondIterator)

    expect(secondPermission.requestId).not.toBe(firstPermission.requestId)

    runtime.respondPermission({
      requestId: secondPermission.requestId,
      decision: "allow",
    })
    await collectEvents(secondIterator)

    expect(harness.repository.permissionRequests.listByRun(firstRun.run.id)).toMatchObject([
      { id: firstPermission.requestId, status: "approved" },
    ])
    expect(harness.repository.permissionRequests.listByRun(secondRun.run.id)).toMatchObject([
      { id: secondPermission.requestId, status: "approved" },
    ])
  })

  test("a fresh runtime instance can reply to a pending request from the same sqlite state", async () => {
    const harness = await createHarness("permission-reopen-reply", false)
    const firstRuntime = createPermissionRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Write finished." }
        },
      ]),
      harness,
      permissionPolicy: {
        write: "ask",
      },
    })
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_reopen_reply",
      messageId: "message_permission_reopen_reply_user",
      prompt: "Write notes.txt",
    })

    const handle = await firstRuntime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    const reopenedDatabase = trackDatabase(openStorageDatabase(harness.databasePath))
    const reopenedRepository = createStorageRepository({
      database: reopenedDatabase,
      now: harness.now,
    })
    const secondRuntime = createRuntime({
      provider: createTurnProvider([], []),
      repository: reopenedRepository,
      now: harness.now,
      permissionPolicy: {
        write: "ask",
      },
    }) as RuntimeController

    secondRuntime.respondPermission({
      requestId: permissionEvent.requestId,
      decision: "allow",
    })

    const remainingEvents = await collectEvents(iterator)

    expect(await readFile(join(harness.workspaceRoot, "notes.txt"), "utf8")).toBe("hello")
    expect(remainingEvents.at(-1)).toMatchObject({
      type: "run.completed",
      runId: started.run.id,
    })
    expect(reopenedRepository.permissionRequests.get(permissionEvent.requestId)).toMatchObject({
      id: permissionEvent.requestId,
      status: "approved",
    })
  })

  test("replying to an unknown permission request fails explicitly", async () => {
    const harness = await createHarness("permission-missing", false)
    const runtime = createPermissionRuntime({
      provider: createTurnProvider([], []),
      harness,
    })

    expect(() =>
      runtime.respondPermission({
        requestId: "permission_missing",
        decision: "allow",
      }),
    ).toThrow(StorageNotFoundError)
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
    databasePath: join(directory, "agent.sqlite"),
    now,
  }
}

function createPermissionRuntime(input: {
  provider: Provider
  harness: Awaited<ReturnType<typeof createHarness>>
  permissionPolicy?: Partial<Record<"write" | "edit" | "shell", "allow" | "ask" | "deny">>
}) {
  return createRuntime({
    provider: input.provider,
    repository: input.harness.repository,
    now: input.harness.now,
    permissionPolicy: input.permissionPolicy,
  }) as RuntimeController
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

async function waitForPermissionRequest(iterator: AsyncIterator<unknown>) {
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      break
    }

    const event = next.value
    if (event != null && typeof event === "object" && "type" in event && event.type === "permission.requested") {
      return event as Extract<
        Awaited<ReturnType<typeof collectEvents>>[number],
        { type: "permission.requested" }
      >
    }
  }

  throw new Error("Expected permission.requested before the event stream closed")
}

async function collectEvents(events: AsyncIterator<unknown>) {
  const collected = []
  while (true) {
    const next = await events.next()
    if (next.done) {
      break
    }
    collected.push(next.value)
  }
  return collected
}

async function fileExists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
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
