import type {
  SessionRepository,
  StoredRun,
  TranscriptMessage,
} from "./ports/repository"

export class RunInitiatingMessageNotFoundError extends Error {
  readonly runId: string

  constructor(runId: string) {
    super(`Run ${runId} is missing its initiating user message`)
    this.name = "RunInitiatingMessageNotFoundError"
    this.runId = runId
  }
}

export type CreateSessionTranscriptServiceInput = {
  repository: SessionRepository
}

export function createSessionTranscriptService(
  input: CreateSessionTranscriptServiceInput,
) {
  const repository = input.repository

  return {
    listSessionTranscript(sessionId: string) {
      return repository.messages.listSessionTranscript(sessionId)
    },
    getInitiatingMessage(run: StoredRun) {
      const sessionTranscript = repository.messages.listSessionTranscript(run.sessionId)
      const initiatingMessage = sessionTranscript.find(
        (message) => message.runId === run.id && message.role === "user" && message.sequence === 0,
      )

      if (!initiatingMessage) {
        throw new RunInitiatingMessageNotFoundError(run.id)
      }

      return initiatingMessage
    },
  }
}

export type SessionTranscriptService = ReturnType<typeof createSessionTranscriptService>

export type { TranscriptMessage }
