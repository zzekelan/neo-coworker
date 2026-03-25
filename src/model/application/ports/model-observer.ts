export type ModelObserverEvent = {
  type: "model.turn.requested"
  sessionId: string
  runId: string
}

export type ModelObserverPort = {
  recordModelEvent?(event: ModelObserverEvent): void
}
