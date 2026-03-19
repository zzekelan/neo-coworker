import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createModelRuntimeApi,
  type ProviderEvent,
  type ProviderTurnRequest,
} from "../../src/model/runtime/api"
import { createModelProvider } from "../../src/model/wiring/provider"
import type { OrchestrationModelPort } from "../../src/orchestration/ports/model"
import { createPermissionRepository } from "../../src/permission/repo"
import { createAgentServer } from "../../src/orchestration/wiring/server"
import {
  type SessionRepository,
  createSessionRepository as createStorageRepository,
  openSessionDatabase as openStorageDatabase,
} from "../../src/session/repo"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []
const activeServers: Array<{ stop(): Promise<void> | void }> = []

afterEach(async () => {
  while (activeServers.length > 0) {
    await activeServers.pop()?.stop()
  }

  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("server HTTP API and SSE", () => {
  test("creates session, starts run, and exposes session and transcript state over HTTP", async () => {
    const harness = await createHarness("server-http-happy", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "Server says hi." }
      },
    ]))

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    expect(createdSession.status).toBe(201)

    const sessionId = createdSession.body.data.session.id as string

    const listedSessions = await requestJson(harness.server, "GET", "/sessions")
    expect(listedSessions.status).toBe(200)
    expect(listedSessions.body.data.sessions).toEqual([
      expect.objectContaining({
        id: sessionId,
        directory: harness.workspaceRoot,
        workspaceRoot: harness.workspaceRoot,
      }),
    ])

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Say hi from the server",
      },
    )
    expect(startedRun.status).toBe(201)
    expect(startedRun.body.data.run).toMatchObject({
      sessionId,
      trigger: "prompt",
      status: "queued",
    })

    const runId = startedRun.body.data.run.id as string

    const completedRun = await waitForRunStatus(harness.server, runId, "completed")
    expect(completedRun.permissionRequests).toEqual([])

    const sessionState = await requestJson(harness.server, "GET", `/sessions/${sessionId}`)
    expect(sessionState.status).toBe(200)
    expect(sessionState.body.data).toMatchObject({
      session: {
        id: sessionId,
      },
      latestRun: {
        id: runId,
        status: "completed",
      },
      activeRun: null,
      status: "idle",
    })

    const listedRuns = await requestJson(harness.server, "GET", `/sessions/${sessionId}/runs`)
    expect(listedRuns.status).toBe(200)
    expect(listedRuns.body.data.runs).toEqual([
      expect.objectContaining({
        id: runId,
        status: "completed",
      }),
    ])

    const transcript = await requestJson(harness.server, "GET", `/sessions/${sessionId}/transcript`)
    expect(transcript.status).toBe(200)
    expect(transcript.body.data.transcript).toMatchObject([
      {
        runId,
        role: "user",
        parts: [{ kind: "text", text: "Say hi from the server" }],
      },
      {
        runId,
        role: "assistant",
        parts: [{ kind: "text", text: "Server says hi." }],
      },
    ])
  })

  test("failed prompt persistence does not leave the session busy", async () => {
    let failNextPromptWrite = true
    const harness = await createHarness(
      "server-http-start-run-rollback",
      createTurnProvider([
        async function* () {
          yield { type: "text.delta", text: "Recovered after rollback." }
        },
      ]),
      {
        repositoryFactory(repository) {
          return {
            ...repository,
            createQueuedRunWithInitiatingMessageAndPart(input) {
              if (failNextPromptWrite) {
                failNextPromptWrite = false
                throw new Error("disk full")
              }

              return repository.createQueuedRunWithInitiatingMessageAndPart(input)
            },
          }
        },
      },
    )

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const failedStart = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "This one should roll back",
      },
    )

    expect(failedStart.status).toBe(500)
    expect(failedStart.body).toMatchObject({
      error: {
        code: "internal_error",
        message: "disk full",
      },
    })
    expect(harness.repository.runs.listBySession(sessionId)).toEqual([])

    const sessionStateAfterFailure = await requestJson(harness.server, "GET", `/sessions/${sessionId}`)
    expect(sessionStateAfterFailure.status).toBe(200)
    expect(sessionStateAfterFailure.body.data).toMatchObject({
      latestRun: null,
      activeRun: null,
      status: "idle",
    })

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "This one should succeed",
      },
    )
    expect(startedRun.status).toBe(201)

    const runId = startedRun.body.data.run.id as string
    const completedRun = await waitForRunStatus(harness.server, runId, "completed")

    expect(completedRun.run).toMatchObject({
      id: runId,
      status: "completed",
    })
  })

  test("SSE sends heartbeat and duplicate subscribers receive the same live run and part updates", async () => {
    const harness = await createHarness("server-sse-dup", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "Streaming " }
        await Bun.sleep(30)
        yield { type: "text.delta", text: "from SSE." }
      },
    ]))

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const subscriberA = await connectSse(harness.server)
    const subscriberB = await connectSse(harness.server)

    expect(await subscriberA.next((event) => event.event === "heartbeat")).toMatchObject({
      event: "heartbeat",
      data: {
        type: "heartbeat",
      },
    })
    expect(await subscriberB.next((event) => event.event === "heartbeat")).toMatchObject({
      event: "heartbeat",
      data: {
        type: "heartbeat",
      },
    })

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Show me SSE",
      },
    )
    const runId = startedRun.body.data.run.id as string

    const eventsA = await collectEventsUntil(subscriberA, (event) =>
      event.event === "run.updated" && event.data.run.status === "completed",
    )
    const eventsB = await collectEventsUntil(subscriberB, (event) =>
      event.event === "run.updated" && event.data.run.status === "completed",
    )

    const filteredA = simplifyRelevantEvents(eventsA, runId)
    const filteredB = simplifyRelevantEvents(eventsB, runId)

    expect(filteredA).toEqual(filteredB)
    expect(filteredA).toEqual(
      expect.arrayContaining([
        { event: "run.updated", id: runId, status: "running" },
        { event: "message.part.updated", id: expect.any(String), kind: "text" },
        { event: "run.updated", id: runId, status: "completed" },
      ]),
    )

    await subscriberA.close()
    await subscriberB.close()
  })

  test("disables Bun idle timeout for SSE subscriptions", async () => {
    const harness = await createHarness("server-sse-timeout", createTurnProvider([]))
    const request = new Request("http://server.test/events", {
      headers: {
        accept: "text/event-stream",
      },
    })
    const timeoutCalls: Array<{ request: Request; seconds: number }> = []

    const response = await harness.server.fetch(request, {
      timeout(receivedRequest, seconds) {
        timeoutCalls.push({
          request: receivedRequest,
          seconds,
        })
      },
    } as unknown as Parameters<typeof harness.server.fetch>[1])

    expect(response.status).toBe(200)
    expect(timeoutCalls).toEqual([
      {
        request,
        seconds: 0,
      },
    ])

    await response.body?.cancel()
  })

  test("permission replies over HTTP resume the paused run and complete the work", async () => {
    const harness = await createHarness("server-permission", createTurnProvider([
      async function* () {
        yield {
          type: "tool.call",
          callId: "call_write",
          name: "write",
          inputText: '{"path":"notes.txt","content":"hello from server"}',
        }
      },
      async function* () {
        yield { type: "text.delta", text: "Write finished." }
      },
    ]), {
      permissionPolicy: {
        write: "ask",
      },
    })

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Write notes.txt",
      },
    )
    const runId = startedRun.body.data.run.id as string

    const waitingRun = await waitForRunStatus(harness.server, runId, "waiting_permission")
    expect(waitingRun.permissionRequests).toHaveLength(1)
    expect(waitingRun.permissionRequests[0]).toMatchObject({
      runId,
      sessionId,
      toolName: "write",
      status: "pending",
    })

    const permissionReply = await requestJson(
      harness.server,
      "POST",
      `/permissions/${waitingRun.permissionRequests[0].id}/reply`,
      {
        decision: "allow",
      },
    )
    expect(permissionReply.status).toBe(200)
    expect(permissionReply.body.data).toMatchObject({
      run: {
        id: runId,
        status: "running",
      },
      permissionRequest: {
        id: waitingRun.permissionRequests[0].id,
        status: "approved",
      },
    })

    const duplicatePermissionReply = await requestJson(
      harness.server,
      "POST",
      `/permissions/${waitingRun.permissionRequests[0].id}/reply`,
      {
        decision: "allow",
      },
    )
    expect(duplicatePermissionReply.status).toBe(409)
    expect(duplicatePermissionReply.body).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("not pending"),
      },
    })

    const completedRun = await waitForRunStatus(harness.server, runId, "completed")
    expect(completedRun.permissionRequests).toMatchObject([
      {
        id: waitingRun.permissionRequests[0].id,
        status: "approved",
      },
    ])
    expect(await readFile(join(harness.workspaceRoot, "notes.txt"), "utf8")).toBe(
      "hello from server",
    )
  })

  test("permission reply returns invalid_state when the request is pending but no active runtime is waiting", async () => {
    const harness = await createHarness("server-permission-stale", createTurnProvider([]))
    const session = harness.repository.sessions.create({
      id: "session_stale_permission",
      directory: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      createdAt: harness.now(),
    })
    const run = harness.repository.runs.create({
      id: "run_stale_permission",
      sessionId: session.id,
      trigger: "prompt",
      status: "waiting_permission",
      createdAt: harness.now(),
      startedAt: harness.now(),
    })
    const permissionRequest = harness.permissionRepository.requests.create({
      id: "permission_stale",
      sessionId: session.id,
      runId: run.id,
      toolName: "write",
      reason: "write notes.txt",
      status: "pending",
      createdAt: harness.now(),
    })

    const response = await requestJson(
      harness.server,
      "POST",
      `/permissions/${permissionRequest.id}/reply`,
      {
        decision: "allow",
      },
    )

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("not awaiting a reply in the active runtime"),
      },
    })
    expect(harness.permissionRepository.requests.get(permissionRequest.id)).toMatchObject({
      id: permissionRequest.id,
      status: "pending",
    })
    expect(harness.repository.runs.get(run.id)).toMatchObject({
      id: run.id,
      status: "waiting_permission",
    })
  })

  test("returns explicit HTTP errors for invalid-state cancel and unknown permission reply", async () => {
    const harness = await createHarness("server-http-errors", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "done" }
      },
    ]))

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Finish quickly",
      },
    )
    const runId = startedRun.body.data.run.id as string
    await waitForRunStatus(harness.server, runId, "completed")

    const invalidCancel = await requestJson(harness.server, "POST", `/runs/${runId}/cancel`)
    expect(invalidCancel.status).toBe(409)
    expect(invalidCancel.body).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("cannot transition"),
      },
    })

    const missingPermissionReply = await requestJson(
      harness.server,
      "POST",
      "/permissions/permission_missing/reply",
      {
        decision: "allow",
      },
    )
    expect(missingPermissionReply.status).toBe(404)
    expect(missingPermissionReply.body).toMatchObject({
      error: {
        code: "not_found",
        message: expect.stringContaining("Unknown permission_request"),
      },
    })
  })

  test("returns invalid_state for duplicate client-specified runId", async () => {
    const harness = await createHarness("server-duplicate-run-id", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "done" }
      },
    ]))
    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const first = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "First run",
      runId: "run_duplicate",
    })
    expect(first.status).toBe(201)
    await waitForRunStatus(harness.server, "run_duplicate", "completed")

    const second = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "Second run",
      runId: "run_duplicate",
    })
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({
      error: {
        code: "invalid_state",
        message: "Run id run_duplicate already exists",
      },
    })
  })

  test("a reconnecting client can refetch final state without historical SSE replay", async () => {
    const harness = await createHarness("server-reconnect", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "first " }
        await Bun.sleep(40)
        yield { type: "text.delta", text: "second" }
      },
    ]))

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const subscriberA = await connectSse(harness.server)
    await subscriberA.next((event) => event.event === "heartbeat")

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Reconnect me",
      },
    )
    const runId = startedRun.body.data.run.id as string

    await subscriberA.next((event) => event.event === "run.updated" && event.data.run.status === "running")
    await subscriberA.close()

    await waitForRunStatus(harness.server, runId, "completed")

    const subscriberB = await connectSse(harness.server)
    expect(await subscriberB.next((event) => event.event === "heartbeat")).toMatchObject({
      event: "heartbeat",
      data: {
        type: "heartbeat",
      },
    })

    const finalRun = await requestJson(harness.server, "GET", `/runs/${runId}`)
    expect(finalRun.status).toBe(200)
    expect(finalRun.body.data.run).toMatchObject({
      id: runId,
      status: "completed",
    })

    const transcript = await requestJson(harness.server, "GET", `/sessions/${sessionId}/transcript`)
    expect(transcript.status).toBe(200)
    expect(transcript.body.data.transcript).toMatchObject([
      {
        runId,
        role: "user",
        parts: [{ kind: "text", text: "Reconnect me" }],
      },
      {
        runId,
        role: "assistant",
        parts: [{ kind: "text", text: "first second" }],
      },
    ])

    await subscriberB.close()
  })
})

async function createHarness(
  prefix: string,
  provider: OrchestrationModelPort,
  options: {
    permissionPolicy?: Partial<Record<"write" | "edit" | "shell", "allow" | "ask" | "deny">>
    repositoryFactory?(repository: SessionRepository): SessionRepository
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  await mkdir(workspaceRoot, { recursive: true })
  await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

  const database = openStorageDatabase(join(directory, "agent.sqlite"))
  openDatabases.push(database)

  const now = createMonotonicClock()
  const baseRepository = createStorageRepository({
    database,
    now,
  })
  const repository = options.repositoryFactory
    ? options.repositoryFactory(baseRepository)
    : baseRepository
  const permissionRepository = createPermissionRepository({
    database,
    now,
  })
  const server = createAgentServer({
    provider,
    repository,
    permissionRepository,
    now,
    heartbeatIntervalMs: 15,
    permissionPolicy: options.permissionPolicy,
  })
  activeServers.push(server)

  return {
    workspaceRoot,
    server,
    repository,
    permissionRepository,
    now,
  }
}

async function requestJson(
  server: { fetch(request: Request): Promise<Response> | Response },
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await server.fetch(
    new Request(`http://server.test${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )

  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  }
}

async function waitForRunStatus(
  server: { fetch(request: Request): Promise<Response> | Response },
  runId: string,
  status: string,
  timeoutMs = 2_000,
) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const run = await requestJson(server, "GET", `/runs/${runId}`)
    if (run.status === 200 && run.body.data.run.status === status) {
      return run.body.data as {
        run: Record<string, any>
        permissionRequests: Array<Record<string, any>>
      }
    }

    await Bun.sleep(20)
  }

  throw new Error(`Timed out waiting for run ${runId} to reach ${status}`)
}

type SseEnvelope = {
  event: string
  data: Record<string, any>
}

async function connectSse(server: { fetch(request: Request): Promise<Response> | Response }) {
  const response = await server.fetch(
    new Request("http://server.test/events", {
      headers: {
        accept: "text/event-stream",
      },
    }),
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(response.body).not.toBeNull()

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const queue: SseEnvelope[] = []
  let buffer = ""
  let closed = false
  let waiter: (() => void) | null = null

  const pump = (async () => {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        closed = true
        waiter?.()
        waiter = null
        return
      }

      buffer += decoder.decode(next.value, { stream: true })

      while (true) {
        const delimiterIndex = buffer.indexOf("\n\n")
        if (delimiterIndex === -1) {
          break
        }

        const block = buffer.slice(0, delimiterIndex)
        buffer = buffer.slice(delimiterIndex + 2)

        const parsed = parseSseBlock(block)
        if (!parsed) {
          continue
        }

        queue.push(parsed)
        waiter?.()
        waiter = null
      }
    }
  })()

  return {
    async next(
      predicate: (event: SseEnvelope) => boolean = () => true,
      timeoutMs = 2_000,
    ) {
      const startedAt = Date.now()

      while (Date.now() - startedAt < timeoutMs) {
        const matchedIndex = queue.findIndex(predicate)
        if (matchedIndex !== -1) {
          return queue.splice(matchedIndex, 1)[0] as SseEnvelope
        }

        if (closed) {
          throw new Error("SSE stream closed before the expected event arrived")
        }

        await Promise.race([
          new Promise<void>((resolve) => {
            waiter = resolve
          }),
          Bun.sleep(20),
        ])
      }

      throw new Error("Timed out waiting for SSE event")
    },
    async close() {
      closed = true
      await reader.cancel()
      await pump
    },
  }
}

function parseSseBlock(block: string): SseEnvelope | null {
  if (!block.trim()) {
    return null
  }

  let event = "message"
  const dataLines: string[] = []

  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue
    }

    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim()
      continue
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim())
    }
  }

  return {
    event,
    data: JSON.parse(dataLines.join("\n")),
  }
}

async function collectEventsUntil(
  subscriber: {
    next(predicate?: (event: SseEnvelope) => boolean, timeoutMs?: number): Promise<SseEnvelope>
  },
  predicate: (event: SseEnvelope) => boolean,
) {
  const events: SseEnvelope[] = []

  while (true) {
    const event = await subscriber.next()
    events.push(event)

    if (predicate(event)) {
      return events
    }
  }
}

function simplifyRelevantEvents(events: SseEnvelope[], runId: string) {
  return events
    .filter((event) =>
      event.event === "run.updated" ||
      event.event === "message.part.updated",
    )
    .filter((event) =>
      event.event === "run.updated"
        ? event.data.run.id === runId
        : event.data.part.runId === runId,
    )
    .map((event) => {
      if (event.event === "run.updated") {
        return {
          event: event.event,
          id: event.data.run.id,
          status: event.data.run.status,
        }
      }

      return {
        event: event.event,
        id: event.data.part.id,
        kind: event.data.part.kind,
      }
    })
}

function createTurnProvider(
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
){
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

function createMonotonicClock(start = 1_000) {
  let current = start

  return () => {
    current += 1
    return current
  }
}
