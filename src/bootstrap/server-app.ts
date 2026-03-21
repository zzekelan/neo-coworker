import {
  assertRunStatusTransition,
  createSessionRunService,
  type RunTrigger,
  type SessionRepository as StorageRepository,
  type StoredMessage,
  type StoredPart,
  type StoredRun,
  type StoredSession,
} from "../session"
import { type OrchestrationRuntimeApi } from "../orchestration"
import type {
  PermissionRepository,
  PermissionResponse,
  StoredPermissionRequest,
} from "../permission"

export type SessionSnapshot = {
  session: StoredSession
  latestRun: StoredRun | null
  activeRun: StoredRun | null
  status: "idle" | "busy"
}

export type ServerEventPayload =
  | (SessionSnapshot & {
      type: "session.created" | "session.updated"
      reason?: string
    })
  | {
      type: "run.created" | "run.updated"
      run: StoredRun
    }
  | {
      type: "message.created"
      message: StoredMessage
    }
  | {
      type: "message.part.updated"
      part: StoredPart
    }
  | {
      type: "permission.requested"
      permissionRequest: StoredPermissionRequest
    }
  | {
      type: "permission.updated"
      permissionRequest: StoredPermissionRequest
    }
  | {
      type: "runtime.error"
      sessionId: string
      runId: string
      error: string
    }
  | {
      type: "heartbeat"
    }

export type ServerEvent = ServerEventPayload & {
  id: string
  time: number
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

type EventSubscription = {
  filter?: (event: ServerEvent) => boolean
  queue: ReturnType<typeof createEventQueue<ServerEvent>>
}

type ServerEventBus = ReturnType<typeof createServerEventBus>

export function buildSessionSnapshot(
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

export function createServerEventBus(input: { now?: () => number } = {}) {
  const now = input.now ?? Date.now
  let nextEventId = 0
  const subscriptions = new Set<EventSubscription>()

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
      const subscription: EventSubscription = {
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

export function createObservedRepository(input: {
  repository: StorageRepository
  permissionRepository: PermissionRepository
  events: ServerEventBus
}) {
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

export type ServerAppRuntime = Pick<
  OrchestrationRuntimeApi,
  "run" | "cancelRun" | "respondPermission"
>

export type CreateServerAppRuntime = (input: {
  repository: StorageRepository
  permissionRepository: PermissionRepository
  now: () => number
}) => ServerAppRuntime

export class ServerShuttingDownError extends Error {
  constructor() {
    super("Server is shutting down")
    this.name = "ServerShuttingDownError"
  }
}

export function createServerApp(input: {
  repository: StorageRepository
  permissionRepository: PermissionRepository
  createRuntimeImpl: CreateServerAppRuntime
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const eventBus = createServerEventBus({
    now,
  })
  const observed = createObservedRepository({
    repository: input.repository,
    permissionRepository: input.permissionRepository,
    events: eventBus,
  })
  const repository = observed.repository
  const permissionRepository = observed.permissionRepository
  const sessionRuns = createSessionRunService({
    repository,
    now,
  })
  const runtime = input.createRuntimeImpl({
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
    if (closing) {
      throw new ServerShuttingDownError()
    }

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
    events: eventBus,
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
      list() {
        return repository.sessions.list()
      },
      get(sessionId: string) {
        return buildSessionSnapshot(repository, sessionId)
      },
      transcript(sessionId: string) {
        return repository.messages.listSessionTranscript(sessionId)
      },
    },
    runs: {
      start: startRun,
      list(sessionId: string) {
        return repository.runs.listBySession(sessionId)
      },
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
    subscribe(filter?: Parameters<typeof eventBus.subscribe>[0]) {
      return eventBus.subscribe(filter)
    },
    async close() {
      if (!closing) {
        closing = (async () => {
          const runsToStop = Array.from(activeRuns.values())

          for (const activeRun of runsToStop) {
            activeRun.cancel()
          }

          await Promise.allSettled(runsToStop.map((activeRun) => activeRun.drained))
          eventBus.close()
        })()
      }

      await closing
    },
  }
}

async function drainRunHandle(handle: Awaited<ReturnType<ServerAppRuntime["run"]>>) {
  try {
    for await (const _event of handle.events) {
      // Runtime state changes are emitted from observed repository writes.
    }
  } catch {
    // Runtime failures are persisted through repository updates.
  }
}
