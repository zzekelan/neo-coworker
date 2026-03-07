export type RuntimeEvent =
  | {
      type: "run.started"
      runId: string
    }
  | {
      type: "run.completed"
      runId: string
    }
