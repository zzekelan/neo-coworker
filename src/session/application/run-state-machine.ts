import type {
  RunStatus,
  SessionRepository,
  StoredRun,
} from "./ports/repository"

export const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_permission"] as const
export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const

export const RUN_STATUS_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running"],
  running: ["waiting_permission", "completed", "failed", "cancelled"],
  waiting_permission: ["running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
}

export class RunStateMachineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RunStateMachineError"
  }
}

export class InvalidRunStatusTransitionError extends RunStateMachineError {
  readonly runId: string
  readonly fromStatus: RunStatus
  readonly toStatus: RunStatus

  constructor(input: { runId: string; fromStatus: RunStatus; toStatus: RunStatus }) {
    super(
      `Run ${input.runId} cannot transition from ${input.fromStatus} to ${input.toStatus}`,
    )
    this.name = "InvalidRunStatusTransitionError"
    this.runId = input.runId
    this.fromStatus = input.fromStatus
    this.toStatus = input.toStatus
  }
}

type TransitionRunStatusOptions = {
  errorText?: string | null
}

export function isActiveRunStatus(status: RunStatus) {
  return ACTIVE_RUN_STATUSES.includes(status as (typeof ACTIVE_RUN_STATUSES)[number])
}

export function isTerminalRunStatus(status: RunStatus) {
  return TERMINAL_RUN_STATUSES.includes(status as (typeof TERMINAL_RUN_STATUSES)[number])
}

export function assertRunStatusTransition(
  run: Pick<StoredRun, "id" | "status">,
  nextStatus: RunStatus,
) {
  if (RUN_STATUS_TRANSITIONS[run.status].includes(nextStatus)) {
    return
  }

  throw new InvalidRunStatusTransitionError({
    runId: run.id,
    fromStatus: run.status,
    toStatus: nextStatus,
  })
}

export function createRunStateMachine(input: {
  repository: SessionRepository
  now?: () => number
}) {
  const repository = input.repository
  const now = input.now ?? Date.now

  return {
    transitionRunStatus(runId: string, nextStatus: RunStatus, options: TransitionRunStatusOptions = {}) {
      const current = repository.runs.get(runId)
      assertRunStatusTransition(current, nextStatus)

      return repository.runs.updateStatus({
        runId: current.id,
        status: nextStatus,
        startedAt: resolveStartedAt(current, nextStatus, now),
        finishedAt: resolveFinishedAt(current, nextStatus, now),
        errorText: resolveErrorText(current, nextStatus, options.errorText),
      })
    },
  }
}

function resolveStartedAt(
  current: StoredRun,
  nextStatus: RunStatus,
  now: () => number,
) {
  if (current.status === "queued" && nextStatus === "running") {
    return current.startedAt ?? now()
  }

  return undefined
}

function resolveFinishedAt(
  current: StoredRun,
  nextStatus: RunStatus,
  now: () => number,
) {
  if (isTerminalRunStatus(nextStatus)) {
    return current.finishedAt ?? now()
  }

  return undefined
}

function resolveErrorText(
  current: StoredRun,
  nextStatus: RunStatus,
  errorText: string | null | undefined,
) {
  if (nextStatus === "failed") {
    return errorText === undefined ? current.errorText : errorText
  }

  if (isTerminalRunStatus(nextStatus)) {
    return null
  }

  return current.errorText
}
