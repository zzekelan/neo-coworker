import type { DesktopMessage, DesktopPart } from "./types"

export function normalizeTranscript(messages: DesktopMessage[]) {
  return messages.map((message) => ({
    ...message,
    parts: sortParts(message.parts),
  }))
}

export function upsertTranscriptMessage(messages: DesktopMessage[], message: DesktopMessage) {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index === -1) {
    return normalizeTranscript([...messages, message])
  }

  const next = messages.slice()
  next[index] = {
    ...next[index],
    ...message,
    parts: sortParts(message.parts.length > 0 ? message.parts : next[index].parts),
  }

  return normalizeTranscript(next)
}

export function upsertTranscriptMessagePart(
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

  return normalizeTranscript(next)
}

function sortParts(parts: DesktopPart[]) {
  return parts
    .slice()
    .sort((left, right) => left.sequence - right.sequence || left.createdAt - right.createdAt)
}
