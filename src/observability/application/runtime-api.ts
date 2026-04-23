import type {
  ExportedRunTrace,
  ObservabilityRepository,
  RunEventData,
  RunEventSource,
} from "./ports/repository"
import type { ToolObserverEvent } from "../../tool/application"

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

type MemoryObserverEvent = {
  sessionId: string
  runId: string
  type:
    | "memory.loaded"
    | "memory.add"
    | "memory.replace"
    | "memory.remove"
    | "memory.overflow_rejected"
    | "memory.security_blocked"
  payload: Record<string, unknown>
}

type SkillObserverEvent = {
  sessionId: string
  runId: string
  type: "skill.created" | "skill.patched" | "skill.deleted" | "skill.security_scan"
  payload: Record<string, unknown>
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
      recordToolEvent(event: ToolObserverEvent) {
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
    memoryObserver: {
      recordMemoryEvent(event: MemoryObserverEvent) {
        const normalized = splitObservedEvent(event)

        return recordRunEvent({
          sessionId: event.sessionId,
          runId: event.runId,
          source: "memory",
          eventType: normalized.eventType,
          data: normalized.data,
        })
      },
    },
    skillObserver: {
      recordSkillEvent(event: SkillObserverEvent) {
        const normalized = splitObservedEvent(event)

        return recordRunEvent({
          sessionId: event.sessionId,
          runId: event.runId,
          source: "skill",
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
    recordRunEvent(_event: RecordRunEventInput) {
      return null
    },
    runtimeObserver: {
      recordRuntimeEvent(_inputValue: {
        sessionId: string
        runId: string
        event: RuntimeObserverEvent
        occurredAt?: number
      }) {
        return null
      },
    },
    modelObserver: {
      recordModelEvent(_event: RuntimeObserverEvent & { sessionId: string; runId: string }) {
        return null
      },
    },
    toolObserver: {
      recordToolEvent(_event: ToolObserverEvent) {
        return null
      },
    },
    permissionObserver: {
      recordPermissionEvent(_event: RuntimeObserverEvent & { sessionId: string; runId: string }) {
        return null
      },
    },
    memoryObserver: {
      recordMemoryEvent(_event: MemoryObserverEvent) {
        return null
      },
    },
    skillObserver: {
      recordSkillEvent(_event: SkillObserverEvent) {
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
