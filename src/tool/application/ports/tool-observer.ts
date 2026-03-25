export type ToolObserverEvent =
  | {
      type: "tool.listed"
      sessionId: string
      runId: string
    }
  | {
      type: "tool.executed"
      sessionId: string
      runId: string
      toolName: string
    }

export type ToolObserverPort = {
  recordToolEvent?(event: ToolObserverEvent): void
}
