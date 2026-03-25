import type {
  ExportedRunTrace,
  ObservabilityRepository,
  RunEventData,
  RunEventSource,
} from "./ports/repository"

export type CreateObservabilityRuntimeApiInput = {
  repository: ObservabilityRepository
  now?: () => number
}

type RecordRunEventInput = {
  sessionId: string
  runId: string
  source: RunEventSource
  eventType: string
  data?: RunEventData
  occurredAt?: number
}

type RuntimeObserverEvent = {
  type: string
  [key: string]: unknown
}

function splitObservedEvent(event: RuntimeObserverEvent) {
  const {
    type,
    sessionId: _sessionId,
    runId: _runId,
    ...data
  } = event as RuntimeObserverEvent & {
    sessionId?: string
    runId?: string
  }

  return {
    eventType: type,
    data,
  }
}

export function createObservabilityRuntimeApi(input: CreateObservabilityRuntimeApiInput) {
  const repository = input.repository
  const now = input.now ?? Date.now

  function recordRunEvent(event: RecordRunEventInput) {
    return repository.runEvents.append({
      sessionId: event.sessionId,
      runId: event.runId,
      source: event.source,
      eventType: event.eventType,
      data: event.data ?? {},
      createdAt: event.occurredAt ?? now(),
    })
  }

  return {
    recordRunEvent,
    runtimeObserver: {
      recordRuntimeEvent(inputValue: {
        sessionId: string
        runId: string
        event: RuntimeObserverEvent
        occurredAt?: number
      }) {
        const normalized = splitObservedEvent(inputValue.event)

        return recordRunEvent({
          sessionId: inputValue.sessionId,
          runId: inputValue.runId,
          source: "orchestration",
          eventType: normalized.eventType,
          data: normalized.data,
          occurredAt: inputValue.occurredAt,
        })
      },
    },
    modelObserver: {
      recordModelEvent(event: RuntimeObserverEvent & { sessionId: string; runId: string }) {
        const normalized = splitObservedEvent(event)

        return recordRunEvent({
          sessionId: event.sessionId,
          runId: event.runId,
          source: "model",
          eventType: normalized.eventType,
          data: normalized.data,
        })
      },
    },
    toolObserver: {
      recordToolEvent(event: RuntimeObserverEvent & { sessionId: string; runId: string }) {
        const normalized = splitObservedEvent(event)

        return recordRunEvent({
          sessionId: event.sessionId,
          runId: event.runId,
          source: "tool",
          eventType: normalized.eventType,
          data: normalized.data,
        })
      },
    },
    permissionObserver: {
      recordPermissionEvent(event: RuntimeObserverEvent & { sessionId: string; runId: string }) {
        const normalized = splitObservedEvent(event)

        return recordRunEvent({
          sessionId: event.sessionId,
          runId: event.runId,
          source: "permission",
          eventType: normalized.eventType,
          data: normalized.data,
        })
      },
    },
    listRunEvents(runId: string) {
      return repository.runEvents.listByRun(runId)
    },
    exportRunTrace(runId: string): ExportedRunTrace | null {
      const events = repository.runEvents.listByRun(runId)
      if (events.length === 0) {
        return null
      }

      return {
        sessionId: events[0]!.sessionId,
        runId,
        events,
      }
    },
  }
}

export function createNoopObservabilityRuntimeApi() {
  return {
    recordRunEvent() {
      return null
    },
    runtimeObserver: {
      recordRuntimeEvent() {
        return null
      },
    },
    modelObserver: {
      recordModelEvent() {
        return null
      },
    },
    toolObserver: {
      recordToolEvent() {
        return null
      },
    },
    permissionObserver: {
      recordPermissionEvent() {
        return null
      },
    },
    listRunEvents() {
      return []
    },
    exportRunTrace() {
      return null
    },
  }
}

export type ObservabilityRuntimeApi = ReturnType<typeof createObservabilityRuntimeApi>
