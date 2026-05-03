import type {
  SessionRepository,
  StoredRun,
  TimelineEntry,
  TimelinePart,
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
      return timelineEntriesToTranscriptMessages(repository.timeline.listEntries(sessionId))
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

export function timelineEntriesToTranscriptMessages(entries: TimelineEntry[]): TranscriptMessage[] {
  return entries.map(timelineEntryToTranscriptMessage)
}

export function timelineEntryToTranscriptMessage(entry: TimelineEntry): TranscriptMessage {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    runId: entry.producedByRunId,
    agent: entry.agent,
    role: entry.role,
    sequence: entry.runSequence,
    createdAt: entry.createdAt,
    parts: entry.parts.map(timelinePartToTranscriptPart),
  }
}

export function timelinePartToTranscriptPart(part: TimelinePart) {
  return {
    id: part.id,
    sessionId: part.sessionId,
    runId: part.producedByRunId,
    messageId: part.entryId,
    kind: part.kind,
    sequence: part.sequence,
    text: part.text,
    data: part.data,
    createdAt: part.createdAt,
  }
}

export type { TranscriptMessage }
