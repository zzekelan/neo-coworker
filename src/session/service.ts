import {
  StorageConflictError,
  type RequestPermissionAndPauseRunInput,
  type RunTrigger,
  type StorageRepository,
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

    try {
      return repository.createQueuedRunWithInitiatingMessage({
        run: {
          id: run.runId,
          sessionId: run.sessionId,
          trigger: run.trigger ?? "prompt",
          status: "queued",
          createdAt: run.createdAt,
        },
        message: {
          id: run.messageId,
          sequence: 0,
          createdAt: run.messageCreatedAt,
        },
      })
    } catch (error) {
      if (error instanceof StorageConflictError) {
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
