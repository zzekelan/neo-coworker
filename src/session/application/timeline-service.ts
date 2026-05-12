import type {
  SessionRepository,
  StoredRun,
  TimelineEntry,
  TimelinePart,
  TimelineMessage,
} from "./ports/repository"

export class RunInitiatingMessageNotFoundError extends Error {
  readonly runId: string

  constructor(runId: string) {
    super(`Run ${runId} is missing its initiating user message`)
    this.name = "RunInitiatingMessageNotFoundError"
    this.runId = runId
  }
}

export type CreateSessionTimelineServiceInput = {
  repository: SessionRepository
}

export function createSessionTimelineService(
  input: CreateSessionTimelineServiceInput,
) {
  const repository = input.repository

  return {
    listSessionTimeline(sessionId: string) {
      return timelineEntriesToTimelineMessages(repository.timeline.listEntries(sessionId))
    },
    getInitiatingMessage(run: StoredRun) {
      const sessionTimeline = repository.messages.listSessionTimeline(run.sessionId)
      const initiatingMessage = sessionTimeline.find(
        (message) => message.runId === run.id && message.role === "user" && message.sequence === 0,
      )

      if (!initiatingMessage) {
        throw new RunInitiatingMessageNotFoundError(run.id)
      }

      return initiatingMessage
    },
  }
}

export type SessionTimelineService = ReturnType<typeof createSessionTimelineService>

export function timelineEntriesToTimelineMessages(entries: TimelineEntry[]): TimelineMessage[] {
  return entries.map(timelineEntryToTimelineMessage)
}

export function timelineEntryToTimelineMessage(entry: TimelineEntry): TimelineMessage {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    runId: entry.producedByRunId,
    agent: entry.agent,
    role: entry.role,
    sequence: entry.runSequence,
    createdAt: entry.createdAt,
    parts: entry.parts.map(timelinePartToTimelinePart),
  }
}

export function timelinePartToTimelinePart(part: TimelinePart) {
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

export type { TimelineMessage }
