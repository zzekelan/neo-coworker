import type { ConversationRepository, StoredRun, TranscriptMessage } from "../repo/contract"

export class RunInitiatingMessageNotFoundError extends Error {
  readonly runId: string

  constructor(runId: string) {
    super(`Run ${runId} is missing its initiating user message`)
    this.name = "RunInitiatingMessageNotFoundError"
    this.runId = runId
  }
}

export type CreateConversationTranscriptServiceInput = {
  repository: ConversationRepository
}

export function createConversationTranscriptService(
  input: CreateConversationTranscriptServiceInput,
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

export type ConversationTranscriptService = ReturnType<typeof createConversationTranscriptService>

export type { TranscriptMessage }
