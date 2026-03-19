import {
  type PermissionRepository,
  type PermissionResponse,
  type StoredPermissionRequest,
} from "../permission"
import type {
  OrchestrationModelPort,
  OrchestrationRunHandle,
  OrchestrationRuntimeApi,
} from "../orchestration"
import {
  assertRunStatusTransition,
  createSessionRunService,
  InvalidRunStatusTransitionError,
  type RunTrigger,
  type SessionRepository as StorageRepository,
  type StoredMessage,
  type StoredRun,
  type StoredSession,
} from "../session"
import type { ServerEvent, ServerEventPayload, SessionSnapshot } from "./server-events"

type SendRequest = (request: Request) => Promise<Response> | Response

type JsonErrorBody = {
  error?: {
    code?: string
    message?: string
  }
}

type Subscription = {
  events: AsyncIterable<ServerEvent>
  close(): Promise<void>
}

export type AgentServerClient = {
  createSession(input: {
    directory: string
    workspaceRoot: string
  }): Promise<StoredSession>
  startRun(input: {
    sessionId: string
    prompt: string
    trigger?: StoredRun["trigger"]
  }): Promise<{
    run: StoredRun
    message: StoredMessage
  }>
  getRun(runId: string): Promise<{
    run: StoredRun
    permissionRequests: StoredPermissionRequest[]
  }>
  replyPermission(input: {
    requestId: string
    decision: "allow" | "deny"
  }): Promise<{
    run: StoredRun
    permissionRequest: StoredPermissionRequest
  }>
  cancelRun(runId: string): Promise<StoredRun>
  subscribe(): Promise<Subscription>
}

export type CliServerClientHandle = {
  client: AgentServerClient
  close(): Promise<void>
}

type LocalRuntimeFactory = (input: {
  provider: OrchestrationModelPort
  repository: StorageRepository
  permissionRepository: PermissionRepository
  now: () => number
}) => Pick<OrchestrationRuntimeApi, "run" | "cancelRun" | "respondPermission">

export class AgentServerClientError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(input: { status: number; code?: string | null; message: string }) {
    super(input.message)
    this.name = "AgentServerClientError"
    this.status = input.status
    this.code = input.code ?? null
  }
}

export function createAgentServerClient(input: {
  origin: string
  send?: SendRequest
  fetchImpl?: typeof fetch
}): AgentServerClient {
  const send =
    input.send ??
    ((request: Request) => {
      const fetchImpl = input.fetchImpl ?? fetch
      return fetchImpl(request)
    })

  function createRequest(path: string, init: RequestInit = {}) {
    return new Request(new URL(path, input.origin), init)
  }

  async function requestJson<T>(path: string, init: RequestInit = {}) {
    const response = await send(createRequest(path, init))
    const body = (await readJsonBody(response)) as
      | {
          data: T
        }
      | JsonErrorBody

    if (!response.ok) {
      const errorBody = body as JsonErrorBody
      throw new AgentServerClientError({
        status: response.status,
        code: errorBody.error?.code,
        message:
          errorBody.error?.message ??
          `${init.method ?? "GET"} ${path} failed with status ${response.status}`,
      })
    }

    return (body as { data: T }).data
  }

  return {
    createSession(inputValue) {
      return requestJson<{ session: StoredSession }>("/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(inputValue),
      }).then((data) => data.session)
    },
    startRun(inputValue) {
      return requestJson<{
        run: StoredRun
        message: StoredMessage
      }>(`/sessions/${encodeURIComponent(inputValue.sessionId)}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          prompt: inputValue.prompt,
          trigger: inputValue.trigger,
        }),
      })
    },
    getRun(runId) {
      return requestJson<{
        run: StoredRun
        permissionRequests: StoredPermissionRequest[]
      }>(`/runs/${encodeURIComponent(runId)}`)
    },
    replyPermission(inputValue) {
      return requestJson<{
        run: StoredRun
        permissionRequest: StoredPermissionRequest
      }>(`/permissions/${encodeURIComponent(inputValue.requestId)}/reply`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          decision: inputValue.decision,
        }),
      })
    },
    cancelRun(runId) {
      return requestJson<{
        run: StoredRun
      }>(`/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      }).then((data) => data.run)
    },
    async subscribe() {
      const controller = new AbortController()
      const response = await send(
        createRequest("/events", {
          headers: {
            accept: "text/event-stream",
          },
          signal: controller.signal,
        }),
      )

      if (!response.ok) {
        const body = (await readJsonBody(response)) as JsonErrorBody
        throw new AgentServerClientError({
          status: response.status,
          code: body.error?.code,
          message: body.error?.message ?? `GET /events failed with status ${response.status}`,
        })
      }

      if (!response.body) {
        throw new Error("Server returned an empty SSE response body")
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const queue = createEventQueue<ServerEvent>()
      let buffer = ""
      let closed = false
      let streamError: unknown = null

      const pump = (async () => {
        try {
          while (!closed) {
            const next = await reader.read()
            if (next.done) {
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

              const event = parseSseBlock(block)
              if (!event) {
                continue
              }

              queue.push(event)
            }
          }
        } catch (error) {
          if (!closed) {
            streamError = error
          }
        } finally {
          queue.close()
        }
      })()

      return {
        events: (async function* () {
          for await (const event of queue.stream()) {
            yield event
          }

          if (streamError) {
            throw streamError
          }
        })(),
        async close() {
          if (closed) {
            return
          }

          closed = true
          controller.abort()

          try {
            await reader.cancel()
          } catch {
            // Ignore cancellation errors from already-closed streams.
          }

          await pump
        },
      }
    },
  }
}

export async function createLocalCliServerClient(input: {
  provider: OrchestrationModelPort
  repository: StorageRepository
  permissionRepository: PermissionRepository
  createRuntimeImpl: LocalRuntimeFactory
  now?: () => number
  closeImpl?: () => void | Promise<void>
}) {
  const app = createLocalCliServerApp({
    provider: input.provider,
    repository: input.repository,
    permissionRepository: input.permissionRepository,
    createRuntimeImpl: input.createRuntimeImpl,
    now: input.now,
  })

  return {
    client: {
      async createSession(inputValue) {
        return app.sessions.create(inputValue)
      },
      async startRun(inputValue) {
        return app.runs.start(inputValue)
      },
      async getRun(runId) {
        return app.runs.get(runId)
      },
      async replyPermission(inputValue) {
        return app.permissions.reply(inputValue)
      },
      async cancelRun(runId) {
        try {
          return app.runs.cancel(runId)
        } catch (error) {
          throw mapLocalClientError(error)
        }
      },
      async subscribe() {
        const subscription = app.subscribe()

        return {
          events: subscription.events,
          async close() {
            subscription.unsubscribe()
          },
        }
      },
    },
    async close() {
      await app.close()
      await input.closeImpl?.()
    },
  } satisfies CliServerClientHandle
}

async function readJsonBody(response: Response) {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    return {}
  }

  return response.json()
}

function parseSseBlock(block: string): ServerEvent | null {
  if (!block.trim()) {
    return null
  }

  const dataLines: string[] = []

  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim())
    }
  }

  if (dataLines.length === 0) {
    return null
  }

  return JSON.parse(dataLines.join("\n")) as ServerEvent
}

function createLocalCliServerApp(input: {
  provider: OrchestrationModelPort
  repository: StorageRepository
  permissionRepository: PermissionRepository
  createRuntimeImpl: LocalRuntimeFactory
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const events = createServerEventBus({
    now,
  })
  const observed = createObservedRepository({
    repository: input.repository,
    permissionRepository: input.permissionRepository,
    events,
  })
  const repository = observed.repository
  const permissionRepository = observed.permissionRepository
  const sessionRuns = createSessionRunService({
    repository,
    now,
  })
  const runtime = input.createRuntimeImpl({
    provider: input.provider,
    repository,
    permissionRepository,
    now,
  })
  const activeRuns = new Map<
    string,
    {
      cancel(): void
      drained: Promise<void>
    }
  >()
  let closing: Promise<void> | null = null

  async function startRun(runInput: {
    sessionId: string
    prompt: string
    trigger?: RunTrigger
    runId?: string
    messageId?: string
  }) {
    const createdAt = now()
    const messageCreatedAt = now()
    const started = sessionRuns.startRun({
      sessionId: runInput.sessionId,
      trigger: runInput.trigger ?? "prompt",
      runId: runInput.runId,
      messageId: runInput.messageId,
      createdAt,
      messageCreatedAt,
      promptText: runInput.prompt,
      promptPartCreatedAt: now(),
    })

    const handle = await runtime.run({
      sessionId: runInput.sessionId,
      runId: started.run.id,
    })

    const drained = drainRunHandle(handle).finally(() => {
      activeRuns.delete(started.run.id)
    })

    activeRuns.set(started.run.id, {
      cancel() {
        handle.cancel()
      },
      drained,
    })

    return started
  }

  return {
    sessions: {
      create(sessionInput: {
        directory: string
        workspaceRoot?: string
      }) {
        return repository.sessions.create({
          directory: sessionInput.directory,
          workspaceRoot: sessionInput.workspaceRoot ?? sessionInput.directory,
          createdAt: now(),
        })
      },
    },
    runs: {
      start: startRun,
      get(runId: string) {
        const run = repository.runs.get(runId)
        return {
          run,
          permissionRequests: permissionRepository.requests.listByRun(runId),
        }
      },
      cancel(runId: string) {
        const run = repository.runs.get(runId)
        assertRunStatusTransition(run, "cancelled")
        runtime.cancelRun(runId)
        return repository.runs.get(runId)
      },
    },
    permissions: {
      reply(response: PermissionResponse) {
        runtime.respondPermission(response)
        const permissionRequest = permissionRepository.requests.get(response.requestId)
        return {
          permissionRequest,
          run: repository.runs.get(permissionRequest.runId),
        }
      },
    },
    subscribe(filter?: Parameters<ReturnType<typeof createServerEventBus>["subscribe"]>[0]) {
      return events.subscribe(filter)
    },
    async close() {
      if (closing) {
        await closing
        return
      }

      closing = (async () => {
        const runsToStop = Array.from(activeRuns.values())

        for (const activeRun of runsToStop) {
          activeRun.cancel()
        }

        await Promise.allSettled(runsToStop.map((activeRun) => activeRun.drained))
        events.close()
      })()

      await closing
    },
  }
}

function createServerEventBus(input: { now?: () => number } = {}) {
  const now = input.now ?? Date.now
  let nextEventId = 0
  const subscriptions = new Set<{
    filter?: (event: ServerEvent) => boolean
    queue: ReturnType<typeof createEventQueue<ServerEvent>>
  }>()

  function buildEventId() {
    nextEventId += 1
    return `event_${nextEventId}`
  }

  return {
    publish(payload: ServerEventPayload) {
      const event: ServerEvent = {
        ...payload,
        id: buildEventId(),
        time: now(),
      }

      for (const subscription of subscriptions) {
        if (subscription.filter && !subscription.filter(event)) {
          continue
        }

        subscription.queue.push(event)
      }

      return event
    },
    subscribe(filter?: (event: ServerEvent) => boolean) {
      const queue = createEventQueue<ServerEvent>()
      const subscription = {
        filter,
        queue,
      }
      subscriptions.add(subscription)

      let closed = false

      return {
        events: queue.stream(),
        unsubscribe() {
          if (closed) {
            return
          }

          closed = true
          subscriptions.delete(subscription)
          queue.close()
        },
      }
    },
    close() {
      for (const subscription of subscriptions) {
        subscription.queue.close()
      }

      subscriptions.clear()
    },
  }
}

function mapLocalClientError(error: unknown) {
  if (error instanceof InvalidRunStatusTransitionError) {
    return new AgentServerClientError({
      status: 409,
      code: "invalid_state",
      message: error.message,
    })
  }

  return error
}

function createEventQueue<T>() {
  const items: T[] = []
  let done = false
  let pendingSignal: Promise<void> | undefined
  let notifyPendingSignal: (() => void) | undefined

  function signal() {
    if (!notifyPendingSignal) {
      return
    }

    const notify = notifyPendingSignal
    notifyPendingSignal = undefined
    pendingSignal = undefined
    notify()
  }

  function waitForSignal() {
    if (!pendingSignal) {
      pendingSignal = new Promise<void>((resolve) => {
        notifyPendingSignal = resolve
      })
    }

    return pendingSignal
  }

  return {
    push(item: T) {
      if (done) {
        throw new Error("Cannot push to a closed event queue")
      }

      items.push(item)
      signal()
    },
    close() {
      done = true
      signal()
    },
    async *stream() {
      while (true) {
        if (items.length > 0) {
          yield items.shift() as T
          continue
        }

        if (done) {
          return
        }

        await waitForSignal()
      }
    },
  }
}

function buildSessionSnapshot(
  repository: Pick<StorageRepository, "sessions" | "runs">,
  sessionId: string,
): SessionSnapshot {
  const session = repository.sessions.get(sessionId)
  const latestRun = repository.runs.getLatestBySession(sessionId)
  const activeRun = repository.runs.getActiveBySession(sessionId)

  return {
    session,
    latestRun,
    activeRun,
    status: activeRun ? "busy" : "idle",
  }
}

function createObservedRepository(input: CreateObservedRepositoryInput) {
  const repository = input.repository
  const permissionRepository = input.permissionRepository
  const events = input.events

  function publishSessionUpdated(sessionId: string, reason: string) {
    events.publish({
      type: "session.updated",
      ...buildSessionSnapshot(repository, sessionId),
      reason,
    })
  }

  function publishRunCreated(run: StoredRun) {
    events.publish({
      type: "run.created",
      run,
    })
    publishSessionUpdated(run.sessionId, "run.created")
  }

  function publishRunUpdated(run: StoredRun) {
    events.publish({
      type: "run.updated",
      run,
    })
    publishSessionUpdated(run.sessionId, "run.updated")

    if (run.status === "failed" && run.errorText) {
      events.publish({
        type: "runtime.error",
        sessionId: run.sessionId,
        runId: run.id,
        error: run.errorText,
      })
    }
  }

  const observedRepository: StorageRepository = {
    ...repository,
    sessions: {
      ...repository.sessions,
      create(session) {
        const created = repository.sessions.create(session)
        events.publish({
          type: "session.created",
          ...buildSessionSnapshot(repository, created.id),
        })
        return created
      },
    },
    runs: {
      ...repository.runs,
      create(run) {
        const created = repository.runs.create(run)
        publishRunCreated(created)
        return created
      },
      updateStatus(update) {
        const updated = repository.runs.updateStatus(update)
        publishRunUpdated(updated)
        return updated
      },
    },
    messages: {
      ...repository.messages,
      create(message) {
        const created = repository.messages.create(message)
        events.publish({
          type: "message.created",
          message: created,
        })
        return created
      },
    },
    parts: {
      ...repository.parts,
      create(part) {
        const created = repository.parts.create(part)
        events.publish({
          type: "message.part.updated",
          part: created,
        })
        return created
      },
      updateContent(update) {
        const updated = repository.parts.updateContent(update)
        events.publish({
          type: "message.part.updated",
          part: updated,
        })
        return updated
      },
    },
    createQueuedRunWithInitiatingMessage(inputValue) {
      const created = repository.createQueuedRunWithInitiatingMessage(inputValue)
      publishRunCreated(created.run)
      events.publish({
        type: "message.created",
        message: created.message,
      })
      return created
    },
    createQueuedRunWithInitiatingMessageAndPart(inputValue) {
      const created = repository.createQueuedRunWithInitiatingMessageAndPart(inputValue)
      publishRunCreated(created.run)
      events.publish({
        type: "message.created",
        message: created.message,
      })
      events.publish({
        type: "message.part.updated",
        part: created.part,
      })
      return created
    },
    createAssistantMessageWithFirstPart(inputValue) {
      const created = repository.createAssistantMessageWithFirstPart(inputValue)
      events.publish({
        type: "message.created",
        message: created.message,
      })
      events.publish({
        type: "message.part.updated",
        part: created.part,
      })
      return created
    },
  }

  const observedPermissionRepository: PermissionRepository = {
    ...permissionRepository,
    requests: {
      ...permissionRepository.requests,
      create(request) {
        const created = permissionRepository.requests.create(request)
        events.publish({
          type: "permission.requested",
          permissionRequest: created,
        })
        publishSessionUpdated(created.sessionId, "permission.requested")
        return created
      },
      updateStatus(update) {
        const updated = permissionRepository.requests.updateStatus(update)
        events.publish({
          type: "permission.updated",
          permissionRequest: updated,
        })
        publishSessionUpdated(updated.sessionId, "permission.updated")
        return updated
      },
    },
  }

  return {
    repository: observedRepository,
    permissionRepository: observedPermissionRepository,
  }
}

type CreateObservedRepositoryInput = {
  repository: StorageRepository
  permissionRepository: PermissionRepository
  events: ReturnType<typeof createServerEventBus>
}

async function drainRunHandle(handle: OrchestrationRunHandle) {
  try {
    for await (const _event of handle.events) {
      // Repository writes are already observed and published as ServerEvents.
    }
  } catch {
    // Runtime state changes are persisted through repositories.
  }
}
