import type { DesktopMessage, DesktopPart } from "./types"
import type { DesktopTranscriptMessage, MessagePart } from "./view-types"

export function mapTranscriptMessage(message: DesktopMessage): DesktopTranscriptMessage {
  const callStatuses = collectToolCallStatuses(message.parts)
  const parts = message.parts
    .map((part) => mapMessagePart(part, callStatuses))
    .filter((part): part is MessagePart => part !== null)
  const content = buildMessageContent(parts)
  const hasStructuredParts = parts.some((part) => part.type !== "text")

  return {
    id: message.id,
    role: message.role,
    content,
    parts: hasStructuredParts ? parts : undefined,
    createdAt: toIsoString(message.createdAt),
  }
}

function collectToolCallStatuses(parts: DesktopPart[]) {
  const statuses = new Map<string, "success" | "error">()

  for (const part of parts) {
    if (part.kind === "tool_result") {
      const callId = readObjectString(part.data, "callId")
      if (callId) {
        statuses.set(callId, "success")
      }
      continue
    }

    if (part.kind === "error" && readObjectString(part.data, "source") === "tool") {
      const callId = readObjectString(part.data, "callId")
      if (callId) {
        statuses.set(callId, "error")
      }
    }
  }

  return statuses
}

function mapMessagePart(
  part: DesktopPart,
  callStatuses: Map<string, "success" | "error">,
): MessagePart | null {
  if (part.kind === "tool_call") {
    const callId = readObjectString(part.data, "callId") ?? part.id
    return {
      type: "tool_call",
      toolName: readObjectString(part.data, "toolName") ?? "unknown",
      toolInput: buildToolCallInput(part),
      callId,
      status: callStatuses.get(callId) ?? "pending",
    }
  }

  if (part.kind === "tool_result") {
    return {
      type: "tool_result",
      callId: readObjectString(part.data, "callId") ?? part.id,
      result: part.data ?? part.text ?? "",
    }
  }

  const text = formatPlainPart(part)
  if (!text) {
    return null
  }

  return {
    type: "text",
    text,
  }
}

function buildToolCallInput(part: DesktopPart) {
  if (part.data && typeof part.data === "object") {
    return part.data
  }

  return {
    inputText: part.text ?? "",
  }
}

function buildMessageContent(parts: MessagePart[]) {
  return parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
}

function formatPlainPart(part: DesktopPart) {
  if (part.kind === "text" || part.kind === "reasoning") {
    return part.text ?? ""
  }

  if (part.kind === "step_start") {
    return part.text ? `Step started: ${part.text}` : "Step started"
  }

  if (part.kind === "step_finish") {
    return part.text ? `Step finished: ${part.text}` : "Step finished"
  }

  if (part.kind === "patch") {
    return part.text ? `Patch: ${part.text}` : "Patch updated"
  }

  if (part.kind === "error") {
    return part.text ? `Error: ${part.text}` : "Error"
  }

  return ""
}

function readObjectString(value: unknown, key: string) {
  if (!value || typeof value !== "object") {
    return null
  }

  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === "string" ? candidate : null
}

function toIsoString(value: number) {
  return new Date(value).toISOString()
}
