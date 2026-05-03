import type { DesktopMessage, DesktopPart, RunStatus } from "./types"
import type { DesktopTranscriptMessage, MessagePart } from "./view-types"

type ToolCallStatus = "pending" | "success" | "error" | "cancelled"

export function mapTranscriptMessage(
  message: DesktopMessage,
  input: {
    runStatusById?: ReadonlyMap<string, RunStatus>
  } = {},
): DesktopTranscriptMessage {
  const hasCompactionBoundary = message.parts.some((p) => p.kind === "compaction_boundary")
  const filteredParts = hasCompactionBoundary
    ? message.parts.filter((p) => p.kind !== "text")
    : message.parts
  const callStatuses = collectToolCallStatuses(filteredParts, input.runStatusById?.get(message.runId))
  const derivedReasoningDurationMs = deriveReasoningDurationMs(message, filteredParts)
  const parts = filteredParts
    .map((part) => mapMessagePart(part, callStatuses, derivedReasoningDurationMs))
    .filter((part): part is MessagePart => part !== null)
  const content = buildMessageContent(parts)
  const hasStructuredParts = parts.some((part) => part.type !== "text")

  return {
    id: message.id,
    role: message.role,
    content,
    parts: hasStructuredParts ? parts : undefined,
    createdAt: toIsoString(message.createdAt),
    runId: message.runId,
  }
}

function collectToolCallStatuses(parts: DesktopPart[], runStatus: RunStatus | undefined) {
  const statuses = new Map<string, ToolCallStatus>()
  const callIds: string[] = []

  for (const part of parts) {
    if (part.kind === "tool_call") {
      const callId = readObjectString(part.data, "callId") ?? part.id
      callIds.push(callId)
      continue
    }

    if (part.kind === "tool_result") {
      const callId = readObjectString(part.data, "callId")
      if (callId) {
        statuses.set(callId, readObjectBoolean(part.data, "isError") ? "error" : "success")
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

  for (const callId of callIds) {
    if (statuses.has(callId)) {
      continue
    }

    statuses.set(callId, deriveTerminalToolCallStatus(runStatus))
  }

  return statuses
}

function mapMessagePart(
  part: DesktopPart,
  callStatuses: Map<string, ToolCallStatus>,
  derivedReasoningDurationMs: number | null,
): MessagePart | null {
  if (part.kind === "tool_call") {
    const callId = readObjectString(part.data, "callId") ?? part.id
    return {
      type: "tool_call",
      toolName: readObjectString(part.data, "toolName") ?? "unknown",
      toolInput: buildToolCallInput(part),
      callId,
      status: callStatuses.get(callId) ?? "pending",
      progress: readObjectString(part.data, "progress") ?? undefined,
    }
  }

  if (part.kind === "tool_result") {
    return {
      type: "tool_result",
      callId: readObjectString(part.data, "callId") ?? part.id,
      result: part.data ?? part.text ?? "",
      isError: readObjectBoolean(part.data, "isError") || undefined,
    }
  }

  if (part.kind === "error" && readObjectString(part.data, "source") === "tool") {
    return {
      type: "tool_result",
      callId: readObjectString(part.data, "callId") ?? part.id,
      result: {
        ...(part.data && typeof part.data === "object" ? (part.data as Record<string, unknown>) : {}),
        output: part.text ?? "unknown error",
      },
      isError: true,
    }
  }

  if (part.kind === "compaction_boundary") {
    return {
      type: "compaction_boundary",
      tokensBefore: readObjectNumber(part.data, "tokensBefore") ?? 0,
      tokensAfter: readObjectNumber(part.data, "tokensAfter") ?? 0,
      compressionRatio: readObjectNumber(part.data, "compressionRatio") ?? 0,
      trigger: readObjectString(part.data, "trigger") ?? "auto",
    }
  }

  if (part.kind === "reasoning") {
    const reasoningText = part.text ?? ""
    if (!reasoningText) {
      return null
    }
    const mappedPart: MessagePart = {
      type: "reasoning",
      text: reasoningText,
    }
    const activityLabel = readObjectString(part.data, "activityLabel")
    const durationMs = readObjectNumber(part.data, "durationMs")
    if (activityLabel) {
      mappedPart.activityLabel = activityLabel
    }
    if (durationMs !== null || derivedReasoningDurationMs !== null) {
      mappedPart.durationMs = durationMs ?? derivedReasoningDurationMs ?? undefined
    }
    return mappedPart
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

function deriveReasoningDurationMs(message: DesktopMessage, parts: DesktopPart[]) {
  const reasoningPart = parts.find((part) => part.kind === "reasoning" && (part.text ?? "").trim().length > 0)
  if (!reasoningPart || readObjectNumber(reasoningPart.data, "durationMs") !== null) {
    return null
  }

  const endPart = parts.find((part) =>
    part.sequence > reasoningPart.sequence
    && (part.kind === "tool_call" || part.kind === "text")
  )
  if (!endPart) {
    return null
  }

  return Math.max(0, endPart.createdAt - message.createdAt)
}

function formatPlainPart(part: DesktopPart) {
  if (part.kind === "text") {
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

function readObjectNumber(value: unknown, key: string) {
  if (!value || typeof value !== "object") {
    return null
  }

  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === "number" ? candidate : null
}

function readObjectBoolean(value: unknown, key: string) {
  if (!value || typeof value !== "object") {
    return null
  }

  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === "boolean" ? candidate : null
}

function toIsoString(value: number) {
  return new Date(value).toISOString()
}

function deriveTerminalToolCallStatus(runStatus: RunStatus | undefined): ToolCallStatus {
  if (runStatus === "cancelled") {
    return "cancelled"
  }

  if (runStatus === "completed" || runStatus === "failed") {
    return "error"
  }

  return "pending"
}
