import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Provider, ProviderEvent, ProviderTurnRequest } from "../../src/providers/types"
import { createAgentServer } from "../../src/server"
import {
  createConversationRepository as createStorageRepository,
  openConversationDatabase as openStorageDatabase,
} from "../../src/conversation/repo"

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

describe("server recovery and operator errors", () => {
  test("restart preserves a two-run transcript and keeps a failed run failed", async () => {
    const harness = await createHarness(
      "server-restart-failed",
      createTurnProvider([
        async function* () {
          yield { type: "text.delta", text: "First run completed." }
        },
        async function* () {
          yield { type: "text.delta", text: "Second run before failure." }
          throw new Error("provider exploded after restart coverage")
        },
      ]),
    )

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const firstRun = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "First prompt",
    })
    const firstRunId = firstRun.body.data.run.id as string
    await waitForRunStatus(harness.server, firstRunId, "completed")

    const secondRun = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "Second prompt",
    })
    const secondRunId = secondRun.body.data.run.id as string
    await waitForRunStatus(harness.server, secondRunId, "failed")

    await restartHarness(harness)

    const sessionState = await requestJson(harness.server, "GET", `/sessions/${sessionId}`)
    expect(sessionState.status).toBe(200)
    expect(sessionState.body.data).toMatchObject({
      session: {
        id: sessionId,
      },
      latestRun: {
        id: secondRunId,
        status: "failed",
        errorText: "provider exploded after restart coverage",
      },
      activeRun: null,
      status: "idle",
    })

    const listedRuns = await requestJson(harness.server, "GET", `/sessions/${sessionId}/runs`)
    expect(listedRuns.status).toBe(200)
    expect(listedRuns.body.data.runs).toMatchObject([
      {
        id: firstRunId,
        status: "completed",
      },
      {
        id: secondRunId,
        status: "failed",
        errorText: "provider exploded after restart coverage",
      },
    ])

    const transcript = await requestJson(harness.server, "GET", `/sessions/${sessionId}/transcript`)
    expect(transcript.status).toBe(200)
    expect(transcript.body.data.transcript).toMatchObject([
      {
        runId: firstRunId,
        role: "user",
        parts: [{ kind: "text", text: "First prompt" }],
      },
      {
        runId: firstRunId,
        role: "assistant",
        parts: [{ kind: "text", text: "First run completed." }],
      },
      {
        runId: secondRunId,
        role: "user",
        parts: [{ kind: "text", text: "Second prompt" }],
      },
      {
        runId: secondRunId,
        role: "assistant",
        parts: [
          { kind: "text", text: "Second run before failure." },
          {
            kind: "error",
            text: "provider exploded after restart coverage",
          },
        ],
      },
    ])

    const failedRun = await requestJson(harness.server, "GET", `/runs/${secondRunId}`)
    expect(failedRun.status).toBe(200)
    expect(failedRun.body.data.run).toMatchObject({
      id: secondRunId,
      status: "failed",
      errorText: "provider exploded after restart coverage",
    })
  })

  test("restart keeps a cancelled run cancelled instead of surfacing it as completed", async () => {
    const harness = await createHarness(
      "server-restart-cancelled",
      createTurnProvider([
        async function* (request) {
          yield { type: "text.delta", text: "Partial output before cancel." }
          await waitForAbort(request.signal)
        },
      ]),
    )

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const startedRun = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "Cancel me",
    })
    const runId = startedRun.body.data.run.id as string

    await waitForRunStatus(harness.server, runId, "running")
    const cancelled = await requestJson(harness.server, "POST", `/runs/${runId}/cancel`)
    expect(cancelled.status).toBe(200)
    await waitForRunStatus(harness.server, runId, "cancelled")

    await restartHarness(harness)

    const sessionState = await requestJson(harness.server, "GET", `/sessions/${sessionId}`)
    expect(sessionState.status).toBe(200)
    expect(sessionState.body.data).toMatchObject({
      latestRun: {
        id: runId,
        status: "cancelled",
      },
      activeRun: null,
      status: "idle",
    })

    const reopenedRun = await requestJson(harness.server, "GET", `/runs/${runId}`)
    expect(reopenedRun.status).toBe(200)
    expect(reopenedRun.body.data.run).toMatchObject({
      id: runId,
      status: "cancelled",
    })

    const transcript = await requestJson(harness.server, "GET", `/sessions/${sessionId}/transcript`)
    expect(transcript.status).toBe(200)
    expect(transcript.body.data.transcript).toMatchObject([
      {
        runId,
        role: "user",
        parts: [{ kind: "text", text: "Cancel me" }],
      },
      {
        runId,
        role: "assistant",
        parts: [{ kind: "text", text: "Partial output before cancel." }],
      },
    ])
  })

  test("stop cancels an active run before shutdown closes storage", async () => {
    let releaseProvider!: () => void
    const continueProvider = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    let abortObserved = false
    const unhandledRejections: string[] = []
    const handleUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason instanceof Error ? reason.message : String(reason))
    }

    process.on("unhandledRejection", handleUnhandledRejection)

    try {
      const harness = await createHarness(
        "server-stop-active-run",
        createTurnProvider([
          async function* (request) {
            yield {
              type: "tool.call",
              callId: "call_read",
              name: "read",
              inputText: '{"path":"placeholder.txt"}',
            }

            await Promise.race([
              continueProvider,
              waitForAbort(request.signal).then(() => {
                abortObserved = true
              }),
            ])
          },
        ]),
      )

      const createdSession = await requestJson(harness.server, "POST", "/sessions", {
        directory: harness.workspaceRoot,
      })
      const sessionId = createdSession.body.data.session.id as string

      const startedRun = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
        prompt: "Read placeholder.txt",
      })
      const runId = startedRun.body.data.run.id as string

      await waitForAssistantToolResult(harness.repository, sessionId, runId)
      await harness.server.stop()

      expect(harness.repository.runs.get(runId).status).toBe("cancelled")
      expect(abortObserved).toBe(true)

      activeServers.pop()
      const database = openDatabases.pop()
      expect(database).toBe(harness.database)
      database?.close(false)

      releaseProvider()
      await Bun.sleep(50)
      expect(unhandledRejections).toEqual([])

      const reopenedConnection = openStorageDatabase(harness.databasePath)
      try {
        const reopenedRepository = createStorageRepository({
          database: reopenedConnection,
          now: harness.now,
        })
        expect(reopenedRepository.runs.get(runId).status).toBe("cancelled")
      } finally {
        reopenedConnection.close(false)
      }
    } finally {
      process.off("unhandledRejection", handleUnhandledRejection)
    }
  })

  test("stop interrupts a running shell tool instead of waiting for command completion", async () => {
    const unhandledRejections: string[] = []
    const handleUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason instanceof Error ? reason.message : String(reason))
    }

    process.on("unhandledRejection", handleUnhandledRejection)

    try {
      const harness = await createHarness(
        "server-stop-shell-tool",
        createTurnProvider([
          async function* () {
            yield {
              type: "tool.call",
              callId: "call_shell",
              name: "shell",
              inputText: '{"command":"sleep 2"}',
            }
          },
        ]),
        {
          permissionPolicy: {
            shell: "allow",
          },
        },
      )

      const createdSession = await requestJson(harness.server, "POST", "/sessions", {
        directory: harness.workspaceRoot,
      })
      const sessionId = createdSession.body.data.session.id as string

      const startedRun = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
        prompt: "Run sleep 2",
      })
      const runId = startedRun.body.data.run.id as string

      await waitForAssistantToolCall(harness.repository, sessionId, runId)

      const startedAt = Date.now()
      await harness.server.stop()
      const elapsed = Date.now() - startedAt

      expect(elapsed).toBeLessThan(1_000)
      expect(harness.repository.runs.get(runId).status).toBe("cancelled")

      activeServers.pop()
      const database = openDatabases.pop()
      expect(database).toBe(harness.database)
      database?.close(false)

      await Bun.sleep(150)
      expect(unhandledRejections).toEqual([])
    } finally {
      process.off("unhandledRejection", handleUnhandledRejection)
    }
  })

  test("returns service_unavailable when a new run is requested during shutdown", async () => {
    const harness = await createHarness(
      "server-shutdown-new-run",
      createTurnProvider([
        async function* (request) {
          yield { type: "text.delta", text: "Still running." }
          await waitForAbort(request.signal)
        },
      ]),
    )

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const startedRun = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "Keep running during shutdown",
    })
    const runId = startedRun.body.data.run.id as string
    await waitForRunStatus(harness.server, runId, "running")

    const stopPromise = harness.server.stop()
    const duringShutdown = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "Reject this new run",
    })

    expect(duringShutdown.status).toBe(503)
    expect(duringShutdown.body).toMatchObject({
      error: {
        code: "service_unavailable",
        message: "Server is shutting down",
      },
    })

    await stopPromise
    expect(harness.repository.runs.get(runId).status).toBe("cancelled")
    activeServers.pop()
  })

  test("returns clear operator-facing errors for missing records and active-run conflicts", async () => {
    const harness = await createHarness(
      "server-operator-errors",
      createTurnProvider([
        async function* (request) {
          yield { type: "text.delta", text: "Still running." }
          await waitForAbort(request.signal)
        },
      ]),
    )

    const missingSession = await requestJson(harness.server, "GET", "/sessions/session_missing")
    expect(missingSession.status).toBe(404)
    expect(missingSession.body).toMatchObject({
      error: {
        code: "not_found",
        message: "Unknown session: session_missing",
      },
    })

    const missingRun = await requestJson(harness.server, "GET", "/runs/run_missing")
    expect(missingRun.status).toBe(404)
    expect(missingRun.body).toMatchObject({
      error: {
        code: "not_found",
        message: "Unknown run: run_missing",
      },
    })

    const missingPermission = await requestJson(
      harness.server,
      "POST",
      "/permissions/permission_missing/reply",
      {
        decision: "allow",
      },
    )
    expect(missingPermission.status).toBe(404)
    expect(missingPermission.body).toMatchObject({
      error: {
        code: "not_found",
        message: "Unknown permission_request: permission_missing",
      },
    })

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const firstRun = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "Keep the session busy",
    })
    const firstRunId = firstRun.body.data.run.id as string
    await waitForRunStatus(harness.server, firstRunId, "running")

    const activeRunConflict = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "This must fail while the first run is active",
    })
    expect(activeRunConflict.status).toBe(409)
    expect(activeRunConflict.body).toMatchObject({
      error: {
        code: "invalid_state",
        message: `Session ${sessionId} already has active run ${firstRunId}`,
      },
    })

    await requestJson(harness.server, "POST", `/runs/${firstRunId}/cancel`)
    await waitForRunStatus(harness.server, firstRunId, "cancelled")
  })
})

async function createHarness(
  prefix: string,
  provider: Provider,
  options: {
    permissionPolicy?: Partial<Record<"write" | "edit" | "shell", "allow" | "ask" | "deny">>
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  await mkdir(workspaceRoot, { recursive: true })
  await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

  const databasePath = join(directory, "agent.sqlite")
  const now = createMonotonicClock()
  const connection = openStorageDatabase(databasePath)
  openDatabases.push(connection)

  const repository = createStorageRepository({
    database: connection,
    now,
  })
  const server = createAgentServer({
    provider,
    repository,
    now,
    permissionPolicy: options.permissionPolicy,
  })
  activeServers.push(server)

  return {
    databasePath,
    database: connection,
    now,
    repository,
    server,
    workspaceRoot,
  }
}

async function restartHarness(harness: {
  databasePath: string
  now: () => number
  server: { stop(): Promise<void> | void }
}) {
  await harness.server.stop()
  activeServers.pop()
  openDatabases.pop()?.close(false)

  const reopenedConnection = openStorageDatabase(harness.databasePath)
  openDatabases.push(reopenedConnection)
  const reopenedRepository = createStorageRepository({
    database: reopenedConnection,
    now: harness.now,
  })
  const reopenedServer = createAgentServer({
    provider: createTurnProvider([]),
    repository: reopenedRepository,
    now: harness.now,
  })
  activeServers.push(reopenedServer)
  harness.server = reopenedServer
}

function createTurnProvider(
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
): Provider {
  let index = 0

  return {
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

async function waitForAssistantToolResult(
  repository: ReturnType<typeof createStorageRepository>,
  sessionId: string,
  runId: string,
  timeoutMs = 2_000,
) {
  return waitForAssistantPart(repository, sessionId, runId, "tool_result", timeoutMs)
}

async function waitForAssistantToolCall(
  repository: ReturnType<typeof createStorageRepository>,
  sessionId: string,
  runId: string,
  timeoutMs = 2_000,
) {
  return waitForAssistantPart(repository, sessionId, runId, "tool_call", timeoutMs)
}

async function waitForAssistantPart(
  repository: ReturnType<typeof createStorageRepository>,
  sessionId: string,
  runId: string,
  partKind: "tool_call" | "tool_result",
  timeoutMs = 2_000,
) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const transcript = repository.messages.listSessionTranscript(sessionId)
    const assistantMessage = transcript.find(
      (message) =>
        message.runId === runId &&
        message.role === "assistant" &&
        message.parts.some((part) => part.kind === partKind),
    )

    if (assistantMessage) {
      return assistantMessage
    }

    await Bun.sleep(20)
  }

  throw new Error(`Timed out waiting for run ${runId} to persist ${partKind}`)
}

async function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) {
    return
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

function createMonotonicClock(start = 1_000) {
  let current = start

  return () => {
    current += 1
    return current
  }
}
