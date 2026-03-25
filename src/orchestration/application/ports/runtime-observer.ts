export type RuntimeObserverEvent = {
  type: string
  [key: string]: unknown
}

export type OrchestrationRuntimeObserverPort = {
  recordRuntimeEvent?(input: {
    sessionId: string
    runId: string
    event: RuntimeObserverEvent
    occurredAt?: number
  }): void
}
