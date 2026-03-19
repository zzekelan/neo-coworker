export const RUN_TRIGGERS = [
  "cli",
  "prompt",
  "command",
  "shell",
  "retry",
  "summarize",
  "init",
] as const

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_permission",
  "completed",
  "failed",
  "cancelled",
] as const

export type RunTrigger = (typeof RUN_TRIGGERS)[number]
export type RunStatus = (typeof RUN_STATUSES)[number]

export type StoredRun = {
  id: string
  sessionId: string
  trigger: RunTrigger
  status: RunStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  errorText: string | null
}
