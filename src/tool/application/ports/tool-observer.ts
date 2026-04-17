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
      type: "budget.turn_over_budget"
      sessionId: string
      runId: string
      payload: {
        turnCumulativeSize: number
        maxChars: number
        trackedToolCount: number
      }
    }
  | {
      type: "budget.spill_largest"
      sessionId: string
      runId: string
      payload: {
        toolName: string
        spilledSize: number
        previewLength: number
        diskPath: string
        remainingBudget: number
      }
    }
  | {
      type: "parallel.plan_generated"
      sessionId: string
      runId: string
      payload: {
        totalCalls: number
        batchCount: number
        maxBatchSize: number
      }
    }
  | {
      type: "parallel.batch_started"
      sessionId: string
      runId: string
      payload: {
        batchIndex: number
        callCount: number
        toolNames: string[]
      }
    }
  | {
      type: "parallel.batch_completed"
      sessionId: string
      runId: string
      payload: {
        batchIndex: number
        durationMs: number
      }
    }
  | {
      type: "parallel.conflict_detected"
      sessionId: string
      runId: string
      payload: {
        tools: string[]
        conflictingPaths: string[]
      }
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
