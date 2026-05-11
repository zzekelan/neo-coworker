import type { DesktopMessage, DesktopPart } from "./types"

type CanonicalTimelinePart = Omit<DesktopPart, "runId" | "messageId"> & {
  producedByRunId: string
  entryId: string
}

type CanonicalTimelineMessage = Omit<DesktopMessage, "runId" | "sequence" | "parts"> & {
  producedByRunId: string
  runSequence: number
  timelineSequence: number
  agent?: string
  parts: CanonicalTimelinePart[]
}

type TimelineInputMessage = DesktopMessage | CanonicalTimelineMessage
type TimelineInputPart = DesktopPart | CanonicalTimelinePart

export function normalizeTimeline(messages: TimelineInputMessage[]) {
  return messages.map(normalizeTimelineMessage)
}

export function upsertTimelineMessage(messages: DesktopMessage[], message: DesktopMessage) {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index === -1) {
    return normalizeTimeline([...messages, message])
  }

  const next = messages.slice()
  next[index] = {
    ...next[index],
    ...message,
    parts: sortParts(message.parts.length > 0 ? message.parts : next[index].parts),
  }

  return normalizeTimeline(next)
}

export function upsertTimelineMessagePart(
  messages: DesktopMessage[],
  part: DesktopPart,
) {
  const messageIndex = messages.findIndex((message) => message.id === part.messageId)
  if (messageIndex === -1) {
    return messages
  }

  const next = messages.slice()
  const target = next[messageIndex]
  const partIndex = target.parts.findIndex((candidate) => candidate.id === part.id)
  const parts = target.parts.slice()

  if (partIndex === -1) {
    parts.push(part)
  } else {
    parts[partIndex] = part
  }

  next[messageIndex] = {
    ...target,
    parts: sortParts(parts),
  }

  return normalizeTimeline(next)
}

function normalizeTimelineMessage(message: TimelineInputMessage): DesktopMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    runId: "runId" in message ? message.runId : message.producedByRunId,
    role: message.role,
    sequence: "sequence" in message ? message.sequence : message.runSequence,
    createdAt: message.createdAt,
    parts: sortParts(message.parts.map(normalizeTimelinePart)),
  }
}

function normalizeTimelinePart(part: TimelineInputPart): DesktopPart {
  return {
    id: part.id,
    sessionId: part.sessionId,
    runId: "runId" in part ? part.runId : part.producedByRunId,
    messageId: "messageId" in part ? part.messageId : part.entryId,
    kind: part.kind,
    sequence: part.sequence,
    text: part.text,
    data: part.data,
    createdAt: part.createdAt,
  }
}

function sortParts(parts: DesktopPart[]) {
  return parts
    .slice()
    .sort((left, right) => left.sequence - right.sequence || left.createdAt - right.createdAt)
}

export function updateToolProgress(
  messages: DesktopMessage[],
  toolCallId: string,
  progress: string,
) {
  const next = messages.slice()
  let modified = false

  for (let i = 0; i < next.length; i++) {
    const target = next[i]
    const partIndex = target.parts.findIndex(
      (part) => readToolCallId(part) === toolCallId
    )

    if (partIndex !== -1) {
      const parts = target.parts.slice()
      const p = parts[partIndex]
      parts[partIndex] = {
        ...p,
        data: {
          ...(p.data && typeof p.data === "object" ? p.data : {}),
          progress,
        },
      }
      next[i] = {
        ...target,
        parts: sortParts(parts),
      }
      modified = true
      break
    }
  }

  return modified ? next : messages
}

function readToolCallId(part: DesktopPart) {
  if (part.kind !== "tool_call") {
    return null
  }

  if (!part.data || typeof part.data !== "object" || Array.isArray(part.data)) {
    return null
  }

  const candidate = (part.data as Record<string, unknown>).callId
  return typeof candidate === "string" ? candidate : null
}
