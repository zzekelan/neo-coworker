import {
  StorageConflictError,
  StorageNotFoundError,
  type RequestPermissionAndPauseRunInput,
  type RunTrigger,
  type StorageRepository,
  type StoredPermissionRequest,
  type TranscriptMessage,
  type StoredRun,
} from "../storage"
import { assertRunStatusTransition, createRunStateMachine } from "../run"

export type SessionActivityStatus = "idle" | "busy"

export type SessionRunState = {
  session: ReturnType<StorageRepository["sessions"]["get"]>
  latestRun: StoredRun | null
  activeRun: StoredRun | null
  status: SessionActivityStatus
}

export type StartRunInput = {
  sessionId: string
  trigger?: RunTrigger
  runId?: string
  messageId?: string
  createdAt?: number
  messageCreatedAt?: number
}

export type RetryRunInput = StartRunInput & {
  sourceRunId: string
}

export class SessionRunServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionRunServiceError"
  }
}

export class SessionBusyError extends SessionRunServiceError {
  readonly sessionId: string
  readonly activeRunId: string | null

  constructor(input: { sessionId: string; activeRunId: string | null }) {
    super(
      input.activeRunId
        ? `Session ${input.sessionId} already has active run ${input.activeRunId}`
        : `Session ${input.sessionId} is busy`,
    )
    this.name = "SessionBusyError"
    this.sessionId = input.sessionId
    this.activeRunId = input.activeRunId
  }
}

export class StartRunIdentityConflictError extends SessionRunServiceError {
  readonly field: "runId" | "messageId"
  readonly value: string

  constructor(input: { field: "runId" | "messageId"; value: string }) {
    super(
      input.field === "runId"
        ? `Run id ${input.value} already exists`
        : `Initiating message id ${input.value} already exists`,
    )
    this.name = "StartRunIdentityConflictError"
    this.field = input.field
    this.value = input.value
  }
}

export class RetrySourceRunError extends SessionRunServiceError {
  readonly sessionId: string
  readonly runId: string

  constructor(input: { sessionId: string; runId: string }) {
    super(`Run ${input.runId} does not belong to session ${input.sessionId}`)
    this.name = "RetrySourceRunError"
    this.sessionId = input.sessionId
    this.runId = input.runId
  }
}

export class RunInitiatingMessageNotFoundError extends SessionRunServiceError {
  readonly runId: string

  constructor(runId: string) {
    super(`Run ${runId} is missing its initiating user message`)
    this.name = "RunInitiatingMessageNotFoundError"
    this.runId = runId
  }
}

export class PermissionRequestNotPendingError extends SessionRunServiceError {
  readonly requestId: string
  readonly status: StoredPermissionRequest["status"]

  constructor(input: { requestId: string; status: StoredPermissionRequest["status"] }) {
    super(`Permission request ${input.requestId} is not pending (status: ${input.status})`)
    this.name = "PermissionRequestNotPendingError"
    this.requestId = input.requestId
    this.status = input.status
  }
}

export class PermissionRequestRunStateError extends SessionRunServiceError {
  readonly requestId: string
  readonly runId: string
  readonly runStatus: StoredRun["status"]

  constructor(input: { requestId: string; runId: string; runStatus: StoredRun["status"] }) {
    super(
      `Permission request ${input.requestId} cannot be replied while run ${input.runId} is ${input.runStatus}`,
    )
    this.name = "PermissionRequestRunStateError"
    this.requestId = input.requestId
    this.runId = input.runId
    this.runStatus = input.runStatus
  }
}

export function createSessionRunService(input: {
  repository: StorageRepository
  now?: () => number
}) {
  const repository = input.repository
  const now = input.now ?? Date.now
  const runStateMachine = createRunStateMachine({
    repository,
    now,
  })

  function getSessionState(sessionId: string): SessionRunState {
    const session = repository.sessions.get(sessionId)
    const latestRun = repository.runs.getLatestBySession(sessionId)
    const activeRun = repository.runs.getActiveBySession(sessionId)

    return {
      session,
      latestRun,
      activeRun,
      status: activeRun ? "busy" : "idle",
    }
  }

  function startRun(run: StartRunInput) {
    const activeRun = repository.runs.getActiveBySession(run.sessionId)
    if (activeRun) {
      throw new SessionBusyError({
        sessionId: run.sessionId,
        activeRunId: activeRun.id,
      })
    }

    assertStartRunIdentityAvailable(repository, run)

    try {
      return repository.createQueuedRunWithInitiatingMessage({
        run: {
          id: run.runId,
          sessionId: run.sessionId,
          trigger: run.trigger ?? "prompt",
          createdAt: run.createdAt,
        },
        message: {
          id: run.messageId,
          sequence: 0,
          createdAt: run.messageCreatedAt,
        },
      })
    } catch (error) {
      const identityConflict = getStartRunIdentityConflict(repository, run)
      if (identityConflict && isUniqueConstraintError(error)) {
        throw identityConflict
      }

      if (error instanceof StorageConflictError) {
        if (identityConflict) {
          throw identityConflict
        }

        const latestActiveRun = repository.runs.getActiveBySession(run.sessionId)
        throw new SessionBusyError({
          sessionId: run.sessionId,
          activeRunId: latestActiveRun?.id ?? null,
        })
      }

      throw error
    }
  }

  function retryRun(run: RetryRunInput) {
    const sourceRun = repository.runs.get(run.sourceRunId)
    if (sourceRun.sessionId !== run.sessionId) {
      throw new RetrySourceRunError({
        sessionId: run.sessionId,
        runId: sourceRun.id,
      })
    }

    const sourceInitiatingMessage = getInitiatingMessage(repository, sourceRun)
    const nextRun = startRun({
      ...run,
      trigger: "retry",
    })

    return {
      ...nextRun,
      sourceRun,
      sourceInitiatingMessage,
    }
  }

  function transitionRunToRunning(runId: string) {
    return runStateMachine.transitionRunStatus(runId, "running")
  }

  function requestPermission(input: RequestPermissionAndPauseRunInput) {
    const run = repository.runs.get(input.runId)
    assertRunStatusTransition(run, "waiting_permission")
    return repository.requestPermissionAndPauseRun(input)
  }

  function respondPermission(input: {
    requestId: string
    decision: "allow" | "deny"
    resolvedAt?: number
  }) {
    const permissionRequest = repository.permissionRequests.get(input.requestId)
    if (permissionRequest.status !== "pending") {
      throw new PermissionRequestNotPendingError({
        requestId: permissionRequest.id,
        status: permissionRequest.status,
      })
    }

    const run = repository.runs.get(permissionRequest.runId)
    if (run.status !== "waiting_permission") {
      throw new PermissionRequestRunStateError({
        requestId: permissionRequest.id,
        runId: run.id,
        runStatus: run.status,
      })
    }

    const resolvedPermissionRequest = repository.permissionRequests.updateStatus({
      requestId: permissionRequest.id,
      status: input.decision === "allow" ? "approved" : "denied",
      resolvedAt: input.resolvedAt ?? now(),
    })

    return {
      run: runStateMachine.transitionRunStatus(run.id, "running"),
      permissionRequest: resolvedPermissionRequest,
    }
  }

  return {
    getSessionState,
    startRun,
    retryRun,
    transitionRunToRunning,
    resumeRun(runId: string) {
      return transitionRunToRunning(runId)
    },
    completeRun(runId: string) {
      return runStateMachine.transitionRunStatus(runId, "completed")
    },
    failRun(input: { runId: string; errorText?: string | null }) {
      return runStateMachine.transitionRunStatus(input.runId, "failed", {
        errorText: input.errorText ?? null,
      })
    },
    cancelRun(runId: string) {
      const run = repository.runs.get(runId)
      assertRunStatusTransition(run, "cancelled")

      return repository.cancelRunAndPendingPermissions({
        runId,
        finishedAt: now(),
      }).run
    },
    requestPermission,
    respondPermission,
  }
}

function getInitiatingMessage(repository: StorageRepository, run: StoredRun): TranscriptMessage {
  const sessionTranscript = repository.messages.listSessionTranscript(run.sessionId)
  const initiatingMessage = sessionTranscript.find(
    (message) => message.runId === run.id && message.role === "user" && message.sequence === 0,
  )

  if (!initiatingMessage) {
    throw new RunInitiatingMessageNotFoundError(run.id)
  }

  return initiatingMessage
}

function assertStartRunIdentityAvailable(
  repository: StorageRepository,
  run: Pick<StartRunInput, "runId" | "messageId">,
) {
  const conflict = getStartRunIdentityConflict(repository, run)
  if (conflict) {
    throw conflict
  }
}

function getStartRunIdentityConflict(
  repository: StorageRepository,
  run: Pick<StartRunInput, "runId" | "messageId">,
) {
  if (run.runId && entityExists(() => repository.runs.get(run.runId!))) {
    return new StartRunIdentityConflictError({
      field: "runId",
      value: run.runId,
    })
  }

  if (run.messageId && entityExists(() => repository.messages.get(run.messageId!))) {
    return new StartRunIdentityConflictError({
      field: "messageId",
      value: run.messageId,
    })
  }

  return null
}

function entityExists(read: () => unknown) {
  try {
    read()
    return true
  } catch (error) {
    if (error instanceof StorageNotFoundError) {
      return false
    }

    throw error
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && /unique|constraint/i.test(error.message)
}
