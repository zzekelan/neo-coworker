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
  | {
      type: "budget.persisted_to_disk"
      sessionId: string
      runId: string
      toolName: string
      contentSize: number
      path: string
      deduplicated: boolean
    }
  | {
      type: "checkpoint.created"
      sessionId: string
      runId: string
      payload: {
        description: string
        stashRef: string
      }
    }
  | {
      type: "checkpoint.restored"
      sessionId: string
      runId: string
      payload: {
        stashRef: string
      }
    }
  | {
      type: "checkpoint.pruned"
      sessionId: string
      runId: string
      payload: {
        prunedCount: number
        remainingCount: number
      }
    }

export type ToolObserverPort = {
  recordToolEvent?(event: ToolObserverEvent): void
}
