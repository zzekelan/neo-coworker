import { createEventQueue } from "../runtime/stream"
import type { StoredPermissionRequest } from "../../permission/repo"
import type {
  SessionRepository as StorageRepository,
  StoredMessage,
  StoredPart,
  StoredRun,
  StoredSession,
} from "../../session/repo"

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

type EventSubscription = {
  filter?: (event: ServerEvent) => boolean
  queue: ReturnType<typeof createEventQueue<ServerEvent>>
}

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

export function serializeSseEvent(event: ServerEvent) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
