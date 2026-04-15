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
  | {
      type: "budget.result_truncated"
      sessionId: string
      runId: string
      toolName: string
      originalSize: number
      truncatedSize: number
      limit: number
      savedPath: string
    }

export type ToolObserverPort = {
  recordToolEvent?(event: ToolObserverEvent): void
}
