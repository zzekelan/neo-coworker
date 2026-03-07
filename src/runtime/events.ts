export type RuntimeEvent =
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
      type: "tool.call.completed"
      callId: string
      name: string
    }
  | {
      type: "run.completed"
      runId: string
    }
