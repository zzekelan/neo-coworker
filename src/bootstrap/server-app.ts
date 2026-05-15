import {
  assertRunStatusTransition,
  createSessionRuntimeApi,
  SessionBusyError,
  type TimelineEntry,
  type TimelinePart,
  type RunTrigger,
  type SessionRepository as StorageRepository,
  type StoredMessage,
  type StoredPart,
  type StoredRun,
  type StoredSession,
} from "../session"
import {
  type ContextUsageSnapshot,
  type OrchestrationRuntimeApi,
  type RuntimeEvent,
} from "../orchestration"
import type { ExportedRunTrace, RunEventData, RunEventSource } from "../observability"
import type {
  PermissionRepository,
  PermissionResponse,
  StoredPermissionRequest,
} from "../permission"

export type SessionSnapshot = {
  session: StoredSession & {
    latestRunStatus: StoredRun["status"] | null
  }
  latestRun: StoredRun | null
  activeRun: StoredRun | null
  contextUsage: ContextUsageSnapshot | null
  status: "idle" | "busy"
}

export type AppServerNotificationPayload =
  | (SessionSnapshot & {
      type: "session.created" | "session.updated"
      reason?: string
    })
  | {
      type: "session.deleted"
      sessionId: string
      workspaceRoot: string
    }
  | {
      type: "run.created" | "run.updated"
      run: StoredRun
    }
  | {
      type: "timeline.entry.created"
      entry: TimelineEntry
    }
  | {
      type: "timeline.part.updated"
      part: TimelinePart
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
      type: "tool.progress"
      toolCallId: string
      message: string
      timestamp: number
    }
  | {
      type: "context.usage.updated"
      sessionId: string
      runId: string
      contextTokens: number
      contextWindow: number
      utilizationPercent: number
      source: "provider" | "estimated" | null
    }
  | SkillLoadAppServerNotificationPayload
  | SubagentAppServerNotificationPayload
  | {
      type: "heartbeat"
    }

export type SkillLoadAppServerNotificationPayload = {
  type: "skill.load.requested" | "skill.load.completed" | "skill.load.failed"
  sessionId: string
  runId: string
  skillName: string
  status: "requested" | "completed" | "failed"
  reason?: string
  skillPath?: string
  instructionsLength?: number
  agentId?: string
  displayName?: string
  parentRunId?: string
  subRunId?: string
  errorCode?: string
  errorMessage?: string
}

export type SubagentAppServerNotificationPayload = {
  type: "subagent.started" | "subagent.completed" | "subagent.failed"
  sessionId?: string
  runId?: string
  parentRunId: string
  subRunId: string
  agentId: string
  displayName: string
  status: "started" | "completed" | "failed"
  errorCode?: string
  errorMessage?: string
}

export type AppServerNotification = AppServerNotificationPayload & {
  id: string
  time: number
}

function createNotificationQueue<T>() {
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
        throw new Error("Cannot push to a closed notification queue")
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

type NotificationSubscription = {
  filter?: (notification: AppServerNotification) => boolean
  queue: ReturnType<typeof createNotificationQueue<AppServerNotification>>
}

type AppServerNotificationBus = ReturnType<typeof createAppServerNotificationBus>

export function buildSessionSnapshot(
  repository: Pick<StorageRepository, "sessions" | "runs">,
  sessionId: string,
  input: {
    contextUsage?: ContextUsageSnapshot | null
  } = {},
): SessionSnapshot {
  const session = repository.sessions.get(sessionId)
  const latestRun = getLatestVisibleRunBySession(repository, sessionId)
  const activeRun = getVisibleRun(repository.runs.getActiveBySession(sessionId))

  return {
    session: {
      ...session,
      latestRunStatus: latestRun?.status ?? null,
    },
    latestRun,
    activeRun,
    contextUsage: input.contextUsage ?? null,
    status: activeRun ? "busy" : "idle",
  }
}

function timelineEntryFromStoredMessage(message: StoredMessage): TimelineEntry {
  return {
    id: message.id,
    sessionId: message.sessionId,
    producedByRunId: message.runId,
    agent: message.agent,
    role: message.role,
    runSequence: message.sequence,
    timelineSequence: message.sequence,
    createdAt: message.createdAt,
    parts: [],
  }
}

function timelinePartFromStoredPart(part: StoredPart): TimelinePart {
  return {
    id: part.id,
    sessionId: part.sessionId,
    producedByRunId: part.runId,
    entryId: part.messageId,
    kind: part.kind,
    sequence: part.sequence,
    text: part.text,
    data: part.data,
    createdAt: part.createdAt,
  }
}

function getVisibleRun(run: StoredRun | null) {
  return run?.trigger === "summarize" ? null : run
}

function getLatestVisibleRunBySession(
  repository: Pick<StorageRepository, "runs">,
  sessionId: string,
) {
  return repository
    .runs
    .listBySession(sessionId)
    .filter((run) => run.trigger !== "summarize")
    .at(-1) ?? null
}

function listVisibleRunsBySession(
  repository: Pick<StorageRepository, "runs">,
  sessionId: string,
) {
  return repository.runs.listBySession(sessionId).filter((run) => run.trigger !== "summarize")
}

export function createAppServerNotificationBus(input: { now?: () => number } = {}) {
  const now = input.now ?? Date.now
  let nextNotificationId = 0
  const subscriptions = new Set<NotificationSubscription>()

  function buildNotificationId() {
    nextNotificationId += 1
    return `notification_${nextNotificationId}`
  }

  return {
    publish(payload: AppServerNotificationPayload) {
      const notification: AppServerNotification = {
        ...payload,
        id: buildNotificationId(),
        time: now(),
      }

      for (const subscription of subscriptions) {
        if (subscription.filter && !subscription.filter(notification)) {
          continue
        }

        subscription.queue.push(notification)
      }

      return notification
    },
    subscribe(filter?: (notification: AppServerNotification) => boolean) {
      const queue = createNotificationQueue<AppServerNotification>()
      const subscription: NotificationSubscription = {
        filter,
        queue,
      }
      subscriptions.add(subscription)

      let closed = false

      return {
        notifications: queue.stream(),
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
  notifications: AppServerNotificationBus
  getContextUsage?: (sessionId: string) => ContextUsageSnapshot | null
}) {
  const repository = input.repository
  const permissionRepository = input.permissionRepository
  const notifications = input.notifications

  function publishSessionUpdated(sessionId: string, reason: string) {
    const snapshot = buildSessionSnapshot(repository, sessionId, {
      contextUsage: input.getContextUsage?.(sessionId) ?? null,
    })

    if (snapshot.session.parentSessionId != null) {
      return
    }

    notifications.publish({
      type: "session.updated",
      ...snapshot,
      reason,
    })
  }

  function publishRunCreated(run: StoredRun) {
    if (run.trigger === "summarize") {
      return
    }

    notifications.publish({
      type: "run.created",
      run,
    })
    publishSessionUpdated(run.sessionId, "run.created")
  }

  function publishRunUpdated(run: StoredRun) {
    if (run.trigger === "summarize") {
      return
    }

    notifications.publish({
      type: "run.updated",
      run,
    })
    publishSessionUpdated(run.sessionId, "run.updated")
  }

  const observedRepository: StorageRepository = {
    ...repository,
    sessions: {
      ...repository.sessions,
      create(session) {
        const created = repository.sessions.create(session)
        if (created.parentSessionId != null) {
          return created
        }

        notifications.publish({
          type: "session.created",
          ...buildSessionSnapshot(repository, created.id, {
            contextUsage: input.getContextUsage?.(created.id) ?? null,
          }),
        })
        return created
      },
      update(session) {
        const updated = repository.sessions.update(session)
        publishSessionUpdated(updated.id, "session.updated")
        return updated
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
      addActiveSkills(update) {
        const updated = repository.runs.addActiveSkills(update)
        publishRunUpdated(updated)
        return updated
      },
      updateTokenUsage(update) {
        const updated = repository.runs.updateTokenUsage(update)
        publishRunUpdated(updated)
        return updated
      },
    },
    messages: {
      ...repository.messages,
      create(message) {
        const created = repository.messages.create(message)
        notifications.publish({
          type: "timeline.entry.created",
          entry: timelineEntryFromStoredMessage(created),
        })
        return created
      },
    },
    timeline: {
      ...repository.timeline,
      appendEntry(entry) {
        const created = repository.timeline.appendEntry(entry)
        notifications.publish({
          type: "timeline.entry.created",
          entry: created,
        })
        return created
      },
      appendPart(part) {
        const created = repository.timeline.appendPart(part)
        notifications.publish({
          type: "timeline.part.updated",
          part: created,
        })
        return created
      },
    },
    parts: {
      ...repository.parts,
      create(part) {
        const created = repository.parts.create(part)
        notifications.publish({
          type: "timeline.part.updated",
          part: timelinePartFromStoredPart(created),
        })
        return created
      },
      updateContent(update) {
        const updated = repository.parts.updateContent(update)
        notifications.publish({
          type: "timeline.part.updated",
          part: timelinePartFromStoredPart(updated),
        })
        return updated
      },
    },
    createQueuedRunWithInitiatingMessage(inputValue) {
      const created = repository.createQueuedRunWithInitiatingMessage(inputValue)
      publishRunCreated(created.run)
      notifications.publish({
        type: "timeline.entry.created",
        entry: timelineEntryFromStoredMessage(created.message),
      })
      return created
    },
    createQueuedRunWithInitiatingMessageAndPart(inputValue) {
      const created = repository.createQueuedRunWithInitiatingMessageAndPart(inputValue)
      publishRunCreated(created.run)
      notifications.publish({
        type: "timeline.entry.created",
        entry: timelineEntryFromStoredMessage(created.message),
      })
      notifications.publish({
        type: "timeline.part.updated",
        part: timelinePartFromStoredPart(created.part),
      })
      return created
    },
    createAssistantMessageWithFirstPart(inputValue) {
      const created = repository.createAssistantMessageWithFirstPart(inputValue)
      notifications.publish({
        type: "timeline.entry.created",
        entry: timelineEntryFromStoredMessage(created.message),
      })
      notifications.publish({
        type: "timeline.part.updated",
        part: timelinePartFromStoredPart(created.part),
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
        notifications.publish({
          type: "permission.requested",
          permissionRequest: created,
        })
        publishSessionUpdated(created.sessionId, "permission.requested")
        return created
      },
      updateStatus(update) {
        const updated = permissionRepository.requests.updateStatus(update)
        notifications.publish({
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
  | "run"
  | "compactSession"
  | "cancelRun"
  | "respondPermission"
  | "setSessionThinkingOverride"
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

export class RunTraceNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run trace ${runId} was not found`)
    this.name = "RunTraceNotFoundError"
  }
}

export class SessionAlreadyCompactingError extends Error {
  readonly sessionId: string
  readonly runId: string

  constructor(input: { sessionId: string; runId: string }) {
    super(`Session ${input.sessionId} is already compacting via run ${input.runId}`)
    this.name = "SessionAlreadyCompactingError"
    this.sessionId = input.sessionId
    this.runId = input.runId
  }
}

export function createServerApp(input: {
  repository: StorageRepository
  permissionRepository: PermissionRepository
  createRuntimeImpl: CreateServerAppRuntime
  deleteSessionImpl?: (sessionId: string) => void
  exportRunTraceImpl?: (runId: string) => ExportedRunTrace | null
  recordRunEventImpl?: (input: {
    sessionId: string
    runId: string
    source: RunEventSource
    eventType: string
    data?: RunEventData
    occurredAt?: number
  }) => unknown
  listSkillCatalogImpl?: (workspaceRoot: string) => Promise<
    Array<{
      name: string
      description: string
      path: string
    }>
  >
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const notificationBus = createAppServerNotificationBus({
    now,
  })
  const contextUsageBySession = new Map<string, ContextUsageSnapshot>()
  const observed = createObservedRepository({
    repository: input.repository,
    permissionRepository: input.permissionRepository,
    notifications: notificationBus,
    getContextUsage(sessionId) {
      return contextUsageBySession.get(sessionId) ?? null
    },
  })
  const repository = observed.repository
  const permissionRepository = observed.permissionRepository
  const sessionProvider = createSessionRuntimeApi({
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
  const activeCompactions = new Map<string, string>()
  let closing: Promise<void> | null = null

async function startRun(runInput: {
  sessionId: string
  prompt: string
  trigger?: RunTrigger
  runId?: string
  messageId?: string
  agent?: string
}) {
    if (closing) {
      throw new ServerShuttingDownError()
    }

    const createdAt = now()
    const messageCreatedAt = now()
    const started = sessionProvider.runs.start({
      sessionId: runInput.sessionId,
      trigger: runInput.trigger ?? "prompt",
      runId: runInput.runId,
      messageId: runInput.messageId,
      createdAt,
      messageCreatedAt,
      promptText: runInput.prompt,
      promptPartCreatedAt: now(),
      agent: runInput.agent,
    })
    const resolvedSession = repository.sessions.get(runInput.sessionId)
    recordTelemetryRunEvent({
      sessionId: runInput.sessionId,
      runId: started.run.id,
      source: "orchestration",
      eventType: "agent.selection.resolved",
      data: {
        requestedAgent: runInput.agent ?? null,
        selectedAgent: resolvedSession.currentAgent ?? null,
        currentAgent: resolvedSession.currentAgent ?? null,
      },
    })

    const handle = await runtime.run({
      sessionId: runInput.sessionId,
      runId: started.run.id,
    })

    const drained = drainRunHandle(handle, {
      notifications: notificationBus,
      contextUsageBySession,
      sessionId: runInput.sessionId,
      runId: started.run.id,
    }).finally(() => {
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

  async function compactSession(sessionId: string) {
    if (closing) {
      throw new ServerShuttingDownError()
    }

    const activeCompactionRunId = activeCompactions.get(sessionId)
    if (activeCompactionRunId) {
      throw new SessionAlreadyCompactingError({
        sessionId,
        runId: activeCompactionRunId,
      })
    }

    const started = sessionProvider.runs.startCommand({
      sessionId,
      trigger: "command",
      createdAt: now(),
    })
    activeCompactions.set(sessionId, started.run.id)

    try {
      const handle = await runtime.compactSession({
        sessionId,
        runId: started.run.id,
      })

      const drained = drainRunHandle(handle, {
        notifications: notificationBus,
        contextUsageBySession,
        sessionId,
        runId: started.run.id,
      }).finally(() => {
        activeRuns.delete(started.run.id)
        if (activeCompactions.get(sessionId) === started.run.id) {
          activeCompactions.delete(sessionId)
        }
      })

      activeRuns.set(started.run.id, {
        cancel() {
          handle.cancel()
        },
        drained,
      })

      return started
    } catch (error) {
      if (activeCompactions.get(sessionId) === started.run.id) {
        activeCompactions.delete(sessionId)
      }
      throw error
    }
  }

  return {
    notifications: notificationBus,
    sessions: {
      create(sessionInput: {
        directory: string
        workspaceRoot?: string
        title?: string
      }) {
        const created = repository.sessions.create({
          directory: sessionInput.directory,
          workspaceRoot: sessionInput.workspaceRoot ?? sessionInput.directory,
          title: sessionInput.title,
          createdAt: now(),
        })
        return {
          ...created,
          latestRunStatus: null,
        }
      },
      list() {
        return repository.sessions.listTopLevel().map((session) => ({
          ...session,
          latestRunStatus: getLatestVisibleRunBySession(repository, session.id)?.status ?? null,
        }))
      },
      get(sessionId: string) {
        return buildSessionSnapshot(repository, sessionId, {
          contextUsage: contextUsageBySession.get(sessionId) ?? null,
        })
      },
      addActiveSkills(inputValue: { sessionId: string; activeSkills: string[] }) {
        const activeRun = repository.runs.getActiveBySession(inputValue.sessionId)
        if (activeRun) {
          throw new SessionBusyError({
            sessionId: inputValue.sessionId,
            activeRunId: activeRun.id,
          })
        }

        const updated = repository.sessions.update({
          sessionId: inputValue.sessionId,
          activeSkills: inputValue.activeSkills,
          updatedAt: now(),
        })
        return {
          ...updated,
          latestRunStatus: getLatestVisibleRunBySession(repository, updated.id)?.status ?? null,
        }
      },
      timeline(sessionId: string) {
        return repository.timeline.listEntries(sessionId)
      },
      delete(sessionId: string) {
        if (!input.deleteSessionImpl) {
          throw new Error("Session deletion is not configured for this server instance")
        }

        const session = repository.sessions.get(sessionId)
        contextUsageBySession.delete(sessionId)
        input.deleteSessionImpl(sessionId)
        notificationBus.publish({
          type: "session.deleted",
          sessionId,
          workspaceRoot: session.workspaceRoot,
        })
      },
      setCurrentAgent(inputValue: { sessionId: string; agent: string }) {
        const activeRun = repository.runs.getActiveBySession(inputValue.sessionId)
        if (activeRun) {
          recordTelemetryRunEvent({
            sessionId: inputValue.sessionId,
            runId: activeRun.id,
            source: "orchestration",
            eventType: "agent.change.rejected",
            data: {
              requestedAgent: inputValue.agent,
              selectedAgent: repository.sessions.get(inputValue.sessionId).currentAgent ?? null,
              currentAgent: repository.sessions.get(inputValue.sessionId).currentAgent ?? null,
              activeRunId: activeRun.id,
              reason: "active_run",
            },
          })
          throw new SessionBusyError({
            sessionId: inputValue.sessionId,
            activeRunId: activeRun.id,
          })
        }

        const before = repository.sessions.get(inputValue.sessionId)
        const updated = repository.sessions.setCurrentAgent(inputValue.sessionId, inputValue.agent)
        const latestRun = getLatestVisibleRunBySession(repository, updated.id)
        if (latestRun) {
          recordTelemetryRunEvent({
            sessionId: updated.id,
            runId: latestRun.id,
            source: "orchestration",
            eventType: "agent.selection.updated",
            data: {
              requestedAgent: inputValue.agent,
              selectedAgent: updated.currentAgent ?? null,
              currentAgent: updated.currentAgent ?? null,
              previousAgent: before.currentAgent ?? null,
              trigger: "user",
            },
          })
        }
        return {
          ...updated,
          latestRunStatus: getLatestVisibleRunBySession(repository, updated.id)?.status ?? null,
        }
      },
      continueWithoutThinking(inputValue: { sessionId: string }) {
        const activeRun = repository.runs.getActiveBySession(inputValue.sessionId)
        if (activeRun) {
          throw new SessionBusyError({
            sessionId: inputValue.sessionId,
            activeRunId: activeRun.id,
          })
        }

        runtime.setSessionThinkingOverride({
          sessionId: inputValue.sessionId,
          thinking: { enabled: false },
        })

        return buildSessionSnapshot(repository, inputValue.sessionId, {
          contextUsage: contextUsageBySession.get(inputValue.sessionId) ?? null,
        })
      },
      restoreThinking(inputValue: { sessionId: string }) {
        const activeRun = repository.runs.getActiveBySession(inputValue.sessionId)
        if (activeRun) {
          throw new SessionBusyError({
            sessionId: inputValue.sessionId,
            activeRunId: activeRun.id,
          })
        }

        runtime.setSessionThinkingOverride({
          sessionId: inputValue.sessionId,
          thinking: null,
        })

        return buildSessionSnapshot(repository, inputValue.sessionId, {
          contextUsage: contextUsageBySession.get(inputValue.sessionId) ?? null,
        })
      },
    },
    workspaces: {
      async skills(workspaceRoot: string) {
        return await (input.listSkillCatalogImpl?.(workspaceRoot) ?? Promise.resolve([]))
      },
    },
    runs: {
      start: startRun,
      compact: compactSession,
      list(sessionId: string) {
        return listVisibleRunsBySession(repository, sessionId)
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
      trace(runId: string) {
        repository.runs.get(runId)
        const trace = input.exportRunTraceImpl?.(runId) ?? null

        if (!trace) {
          throw new RunTraceNotFoundError(runId)
        }

        return trace
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
    subscribe(filter?: Parameters<typeof notificationBus.subscribe>[0]) {
      return notificationBus.subscribe(filter)
    },
    async close() {
      if (!closing) {
        closing = (async () => {
          const runsToDrain = Array.from(activeRuns.values()).map((activeRun) => {
            activeRun.cancel()
            return activeRun
          })

          await Promise.allSettled(runsToDrain.map((activeRun) => activeRun.drained))
          notificationBus.close()
        })()
      }

      await closing
    },
  }

  function recordTelemetryRunEvent(inputValue: {
    sessionId: string
    runId: string
    source: RunEventSource
    eventType: string
    data?: RunEventData
  }) {
    try {
      input.recordRunEventImpl?.({
        ...inputValue,
        occurredAt: now(),
      })
    } catch {
      // Observability must not alter session switching or run semantics.
    }
  }
}

async function drainRunHandle(
  handle: Awaited<ReturnType<ServerAppRuntime["run"]>>,
  input: {
    notifications: AppServerNotificationBus
    contextUsageBySession: Map<string, ContextUsageSnapshot>
    sessionId: string
    runId: string
  },
) {
  try {
    for await (const event of handle.events) {
      switch (event.type) {
        case "tool.progress": {
          input.notifications.publish({
            type: "tool.progress",
            toolCallId: event.toolCallId,
            message: event.message,
            timestamp: event.timestamp,
          })
          break
        }
        case "context.usage.updated": {
          input.contextUsageBySession.set(event.sessionId, {
            contextTokens: event.contextTokens,
            contextWindow: event.contextWindow,
            utilizationPercent: event.utilizationPercent,
            source: event.source,
          })
          input.notifications.publish({
            type: "context.usage.updated",
            sessionId: event.sessionId,
            runId: event.runId,
            contextTokens: event.contextTokens,
            contextWindow: event.contextWindow,
            utilizationPercent: event.utilizationPercent,
            source: event.source,
          })
          break
        }
        case "skill.load.requested":
        case "skill.load.completed":
        case "skill.load.failed":
        case "subagent.started":
        case "subagent.completed":
        case "subagent.failed": {
          const lifecycleEvent = buildLifecycleAppServerNotification(event, {
            sessionId: input.sessionId,
            runId: input.runId,
          })
          if (lifecycleEvent) {
            input.notifications.publish(lifecycleEvent)
          }
          break
        }
        default:
          break
      }
    }
  } catch {
    // Runtime failures are persisted through repository updates.
  }
}

function buildLifecycleAppServerNotification(
  event: RuntimeEvent | ({ type: string; [key: string]: unknown }),
  fallback: { sessionId: string; runId: string },
): SkillLoadAppServerNotificationPayload | SubagentAppServerNotificationPayload | null {
  if (isSkillLoadEventType(event.type)) {
    const skillName = readString(event, "skillName")
    if (!skillName) {
      return null
    }

    const status = readLifecycleStatus(event, {
      "skill.load.requested": "requested",
      "skill.load.completed": "completed",
      "skill.load.failed": "failed",
    })
    const payload: SkillLoadAppServerNotificationPayload = {
      type: event.type,
      sessionId: readString(event, "sessionId") ?? fallback.sessionId,
      runId: readString(event, "runId") ?? fallback.runId,
      skillName,
      status,
    }
    const reason = readString(event, "reason")
    const skillPath = readString(event, "skillPath")
    const instructionsLength = readNumber(event, "instructionsLength")
    const agentId = readString(event, "agentId")
    const displayName = readString(event, "displayName")
    const parentRunId = readString(event, "parentRunId")
    const subRunId = readString(event, "subRunId")
    const errorCode = readString(event, "errorCode") ?? (event.type === "skill.load.failed" ? "SKILL_LOAD_FAILED" : null)
    const errorMessage = readString(event, "errorMessage") ?? readString(event, "error")

    if (reason) payload.reason = reason
    if (skillPath) payload.skillPath = skillPath
    if (instructionsLength !== null) payload.instructionsLength = instructionsLength
    if (agentId) payload.agentId = agentId
    if (displayName) payload.displayName = displayName
    if (parentRunId) payload.parentRunId = parentRunId
    if (subRunId) payload.subRunId = subRunId
    if (errorCode) payload.errorCode = errorCode
    if (errorMessage) payload.errorMessage = errorMessage
    return payload
  }

  if (isSubagentEventType(event.type)) {
    const parentRunId = readString(event, "parentRunId")
    const subRunId = readString(event, "subRunId")
    const agentId = readString(event, "agentId") ?? readString(event, "agentName")
    const displayName = readString(event, "displayName") ?? readString(event, "agentDisplayName") ?? agentId
    if (!parentRunId || !subRunId || !agentId || !displayName) {
      return null
    }

    const payload: SubagentAppServerNotificationPayload = {
      type: event.type,
      sessionId: readString(event, "sessionId") ?? fallback.sessionId,
      runId: readString(event, "runId") ?? subRunId,
      parentRunId,
      subRunId,
      agentId,
      displayName,
      status: readLifecycleStatus(event, {
        "subagent.started": "started",
        "subagent.completed": "completed",
        "subagent.failed": "failed",
      }),
    }
    const errorCode = readString(event, "errorCode") ?? (event.type === "subagent.failed" ? "SUBAGENT_FAILED" : null)
    const errorMessage = readString(event, "errorMessage") ?? readString(event, "error")
    if (errorCode) payload.errorCode = errorCode
    if (errorMessage) payload.errorMessage = errorMessage
    return payload
  }

  return null
}

function isSkillLoadEventType(type: string): type is SkillLoadAppServerNotificationPayload["type"] {
  return type === "skill.load.requested" || type === "skill.load.completed" || type === "skill.load.failed"
}

function isSubagentEventType(type: string): type is SubagentAppServerNotificationPayload["type"] {
  return type === "subagent.started" || type === "subagent.completed" || type === "subagent.failed"
}

function readLifecycleStatus<T extends string>(event: { type: string; [key: string]: unknown }, defaults: Record<string, T>) {
  const status = readString(event, "status")
  return (status ?? defaults[event.type]) as T
}

function readString(value: Record<string, unknown>, key: string) {
  return typeof value[key] === "string" ? value[key] : null
}

function readNumber(value: Record<string, unknown>, key: string) {
  return typeof value[key] === "number" ? value[key] : null
}
