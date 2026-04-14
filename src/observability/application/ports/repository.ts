export const RUN_EVENT_SOURCES = [
  "model",
  "orchestration",
  "permission",
  "tool",
  "memory",
  "skill",
] as const

export type RunEventSource = (typeof RUN_EVENT_SOURCES)[number]
export type RunEventData = Record<string, unknown>

export type StoredRunEvent = {
  id: string
  sessionId: string
  runId: string
  sequence: number
  source: RunEventSource
  eventType: string
  data: RunEventData
  createdAt: number
}

export type ExportedRunTrace = {
  sessionId: string
  runId: string
  events: StoredRunEvent[]
}

export type CreateRunEventInput = {
  id?: string
  sessionId: string
  runId: string
  source: RunEventSource
  eventType: string
  data?: RunEventData
  createdAt?: number
}

export type ObservabilityRepository = {
  runEvents: {
    append(input: CreateRunEventInput): StoredRunEvent
    listByRun(runId: string): StoredRunEvent[]
  }
}
