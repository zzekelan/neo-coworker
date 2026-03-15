import {
  ConversationConflictError,
  ConversationNotFoundError,
  type ConversationRepository,
  type RunTrigger,
  type StoredRun,
} from "../repo/contract"
import { createConversationTranscriptService } from "./transcript"
import { createRunStateMachine } from "./state-machine"

export type SessionActivityStatus = "idle" | "busy"

export type SessionRunState = {
  session: ReturnType<ConversationRepository["sessions"]["get"]>
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

export type CreateConversationRunServiceInput = {
  repository: ConversationRepository
  now?: () => number
}

export function createConversationRunService(input: CreateConversationRunServiceInput) {
  const repository = input.repository
  const now = input.now ?? Date.now
  const runStateMachine = createRunStateMachine({
    repository,
    now,
  })
  const transcript = createConversationTranscriptService({ repository })

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

      if (error instanceof ConversationConflictError) {
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

    const sourceInitiatingMessage = transcript.getInitiatingMessage(sourceRun)
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
      return runStateMachine.transitionRunStatus(runId, "cancelled")
    },
  }
}

function assertStartRunIdentityAvailable(
  repository: ConversationRepository,
  run: Pick<StartRunInput, "runId" | "messageId">,
) {
  const conflict = getStartRunIdentityConflict(repository, run)
  if (conflict) {
    throw conflict
  }
}

function getStartRunIdentityConflict(
  repository: ConversationRepository,
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
    if (error instanceof ConversationNotFoundError) {
      return false
    }

    throw error
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && /unique|constraint/i.test(error.message)
}
