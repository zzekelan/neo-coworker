import {
  SessionConflictError,
  SessionNotFoundError,
  type RunTrigger,
  type SessionRepository,
  type StoredRun,
} from "./ports/repository"
import {
  createRunStateMachine,
  isActiveRunStatus,
} from "./run-state-machine"
import { createSessionTimelineService } from "./timeline-service"

export type SessionActivityStatus = "idle" | "busy"

export type SessionRunState = {
  session: ReturnType<SessionRepository["sessions"]["get"]>
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
  promptText?: string
  promptPartCreatedAt?: number
  agent?: string
}

export type RetryRunInput = StartRunInput & {
  sourceRunId: string
}

export type StartCommandRunInput = Omit<
  StartRunInput,
  "messageId" | "messageCreatedAt" | "promptText" | "promptPartCreatedAt"
> & {
  trigger?: "command"
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

export class RunActiveSkillsUpdateStateError extends SessionRunServiceError {
  readonly runId: string
  readonly status: StoredRun["status"]

  constructor(input: { runId: string; status: StoredRun["status"] }) {
    super(`Run ${input.runId} cannot update active skills from status ${input.status}`)
    this.name = "RunActiveSkillsUpdateStateError"
    this.runId = input.runId
    this.status = input.status
  }
}

export class RunTokenUsageUpdateStateError extends SessionRunServiceError {
  readonly runId: string
  readonly status: StoredRun["status"]

  constructor(input: { runId: string; status: StoredRun["status"] }) {
    super(`Run ${input.runId} cannot update token usage from status ${input.status}`)
    this.name = "RunTokenUsageUpdateStateError"
    this.runId = input.runId
    this.status = input.status
  }
}

export type CreateSessionRunServiceInput = {
  repository: SessionRepository
  now?: () => number
}

export function createSessionRunService(input: CreateSessionRunServiceInput) {
  const repository = input.repository
  const now = input.now ?? Date.now
  const runStateMachine = createRunStateMachine({
    repository,
    now,
  })
  const timeline = createSessionTimelineService({ repository })

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

  function getSessionCurrentAgent(sessionId: string) {
    return repository.sessions.getCurrentAgent(sessionId)
  }

  function setSessionCurrentAgent(sessionId: string, agent: string) {
    return repository.sessions.setCurrentAgent(sessionId, agent)
  }

  function startRun(run: StartRunInput) {
    const activeRun = repository.runs.getActiveBySession(run.sessionId)
    if (activeRun) {
      throw new SessionBusyError({
        sessionId: run.sessionId,
        activeRunId: activeRun.id,
      })
    }

    let session = repository.sessions.get(run.sessionId)

    assertStartRunIdentityAvailable(repository, run)

    if (run.agent !== undefined) {
      session = repository.sessions.setCurrentAgent(run.sessionId, run.agent)
    }

    try {
      if (run.promptText !== undefined) {
        return repository.createQueuedRunWithInitiatingMessageAndPart({
          run: {
            id: run.runId,
            sessionId: run.sessionId,
            trigger: run.trigger ?? "prompt",
            createdAt: run.createdAt,
            activeSkills: session.activeSkills,
          },
          message: {
            id: run.messageId,
            agent: session.currentAgent,
            sequence: 0,
            createdAt: run.messageCreatedAt,
          },
          part: {
            kind: "text",
            sequence: 0,
            text: run.promptText,
            createdAt: run.promptPartCreatedAt,
          },
        })
      }

      return repository.createQueuedRunWithInitiatingMessage({
        run: {
          id: run.runId,
          sessionId: run.sessionId,
          trigger: run.trigger ?? "prompt",
          createdAt: run.createdAt,
          activeSkills: session.activeSkills,
        },
        message: {
          id: run.messageId,
          agent: session.currentAgent,
          sequence: 0,
          createdAt: run.messageCreatedAt,
        },
      })
    } catch (error) {
      const identityConflict = getStartRunIdentityConflict(repository, run)
      if (identityConflict && isUniqueConstraintError(error)) {
        throw identityConflict
      }

      if (error instanceof SessionConflictError) {
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

    const sourceInitiatingMessage = timeline.getInitiatingMessage(sourceRun)
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

  function startCommandRun(run: StartCommandRunInput) {
    const activeRun = repository.runs.getActiveBySession(run.sessionId)
    if (activeRun) {
      throw new SessionBusyError({
        sessionId: run.sessionId,
        activeRunId: activeRun.id,
      })
    }

    const session = repository.sessions.get(run.sessionId)

    assertStartRunIdentityAvailable(repository, run)

    try {
      return repository.createQueuedRun({
        run: {
          id: run.runId,
          sessionId: run.sessionId,
          trigger: run.trigger ?? "command",
          createdAt: run.createdAt,
          activeSkills: session.activeSkills,
        },
      })
    } catch (error) {
      const identityConflict = getStartRunIdentityConflict(repository, run)
      if (identityConflict && isUniqueConstraintError(error)) {
        throw identityConflict
      }

      if (error instanceof SessionConflictError) {
        const latestActiveRun = repository.runs.getActiveBySession(run.sessionId)
        throw new SessionBusyError({
          sessionId: run.sessionId,
          activeRunId: latestActiveRun?.id ?? null,
        })
      }

      throw error
    }
  }

  function transitionRunToRunning(runId: string) {
    return runStateMachine.transitionRunStatus(runId, "running")
  }

  function addRunActiveSkills(inputValue: { runId: string; activeSkills: string[] }) {
    const run = repository.runs.get(inputValue.runId)
    if (!isActiveRunStatus(run.status)) {
      throw new RunActiveSkillsUpdateStateError({
        runId: run.id,
        status: run.status,
      })
    }

    return repository.runs.addActiveSkills(inputValue)
  }

  function recordRunTokenUsage(inputValue: {
    runId: string
    inputTokens: number
    outputTokens: number
    tokenUsageSource: StoredRun["tokenUsageSource"]
  }) {
    const run = repository.runs.get(inputValue.runId)
    if (!isActiveRunStatus(run.status)) {
      throw new RunTokenUsageUpdateStateError({
        runId: run.id,
        status: run.status,
      })
    }

    return repository.runs.updateTokenUsage({
      runId: run.id,
      inputTokens: run.inputTokens + normalizeTokenCount(inputValue.inputTokens),
      outputTokens: run.outputTokens + normalizeTokenCount(inputValue.outputTokens),
      tokenUsageSource: mergeTokenUsageSource(run.tokenUsageSource, inputValue.tokenUsageSource),
    })
  }

  return {
    getSessionState,
    getSessionCurrentAgent,
    setSessionCurrentAgent,
    startRun,
    startCommandRun,
    retryRun,
    transitionRunToRunning,
    addRunActiveSkills,
    recordRunTokenUsage,
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
  repository: SessionRepository,
  run: Pick<StartRunInput, "runId" | "messageId">,
) {
  const conflict = getStartRunIdentityConflict(repository, run)
  if (conflict) {
    throw conflict
  }
}

function getStartRunIdentityConflict(
  repository: SessionRepository,
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
    if (error instanceof SessionNotFoundError) {
      return false
    }

    throw error
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && /unique|constraint/i.test(error.message)
}

function normalizeTokenCount(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }

  return Math.round(value)
}

function mergeTokenUsageSource(
  current: StoredRun["tokenUsageSource"],
  next: StoredRun["tokenUsageSource"],
) {
  if (!next) {
    return current
  }

  if (!current) {
    return next
  }

  return current === next ? current : "estimated"
}
