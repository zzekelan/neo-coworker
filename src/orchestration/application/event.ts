export type OrchestrationRuntimeEvent =
  | {
      type: "run.started"
      runId: string
    }
  | {
      type: "message.started"
      role: "assistant"
    }
  | {
      type: "message.delta"
      text: string
    }
  | {
      type: "model.turn.retrying"
      attempt: number
      error: string
    }
  | {
      type: "permission.requested"
      requestId: string
      toolName: string
      reason: string
    }
  | {
      type: "tool.call.completed"
      callId: string
      name: string
      output: string
    }
  | {
      type: "run.completed"
      runId: string
    }
  | {
      type: "run.failed"
      runId: string
      error: string
    }
  | {
      type: "run.cancelled"
      runId: string
    }

export type RuntimeEvent = OrchestrationRuntimeEvent
