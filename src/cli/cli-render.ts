import type { ServerEvent, StoredMessage, StoredRun } from "../bootstrap"
import { formatCompactionBoundaryLine, isCompactionBoundaryPart } from "./compaction-render"

type StoredMessageRole = StoredMessage["role"]

export type CliRenderState = {
  renderedRunStatuses: Map<string, Set<StoredRun["status"]>>
  messageRoles: Map<string, StoredMessageRole>
  printedTextByPartId: Map<string, string>
  printedReasoningByPartId: Map<string, string>
  renderedPartIds: Set<string>
}

export function createCliRenderState(): CliRenderState {
  return {
    renderedRunStatuses: new Map<string, Set<StoredRun["status"]>>(),
    messageRoles: new Map<string, StoredMessageRole>(),
    printedTextByPartId: new Map<string, string>(),
    printedReasoningByPartId: new Map<string, string>(),
    renderedPartIds: new Set<string>(),
  }
}

export function renderServerEvent(state: CliRenderState, event: ServerEvent) {
  switch (event.type) {
    case "heartbeat":
    case "session.created":
    case "session.updated":
    case "context.usage.updated":
    case "permission.updated":
    case "runtime.error":
    case "run.created":
      return ""
    case "run.updated":
      return renderRunStatus(state, event.run)
    case "message.created":
      state.messageRoles.set(event.message.id, event.message.role)
      return event.message.role === "assistant" ? "message.started assistant\n" : ""
    case "message.part.updated":
      return renderAssistantPart(state, event)
    case "permission.requested":
      return `permission.requested ${event.permissionRequest.toolName} ${event.permissionRequest.reason}\n`
  }
}

function renderRunStatus(state: CliRenderState, run: StoredRun) {
  let renderedStatuses = state.renderedRunStatuses.get(run.id)
  if (!renderedStatuses) {
    renderedStatuses = new Set<StoredRun["status"]>()
    state.renderedRunStatuses.set(run.id, renderedStatuses)
  }

  if (renderedStatuses.has(run.status)) {
    return ""
  }

  renderedStatuses.add(run.status)

  switch (run.status) {
    case "queued":
      return ""
    case "running":
      return `run.started ${run.id}\n`
    case "completed":
      return `run.completed ${run.id}\n`
    case "failed":
      return `run.failed ${run.errorText ?? `run ${run.id} failed`}\n`
    case "cancelled":
      return `run.cancelled ${run.id}\n`
    case "waiting_permission":
      return ""
  }
}

function renderAssistantPart(
  state: CliRenderState,
  event: Extract<ServerEvent, { type: "message.part.updated" }>,
) {
  const role = state.messageRoles.get(event.part.messageId)
  if (role !== "assistant" && role !== "synthetic") {
    return ""
  }

  if (role === "synthetic" && event.part.kind === "text") {
    return ""
  }

  if (event.part.kind === "text") {
    return renderTextPart(state, event.part.id, event.part.text)
  }

  if (event.part.kind === "reasoning") {
    return renderReasoningPart(state, event.part.id, event.part.text)
  }

  if (isCompactionBoundaryPart(event.part)) {
    if (state.renderedPartIds.has(event.part.id)) {
      return ""
    }
    state.renderedPartIds.add(event.part.id)
    return formatCompactionBoundaryLine(event.part.data)
  }

  if (state.renderedPartIds.has(event.part.id)) {
    return ""
  }

  state.renderedPartIds.add(event.part.id)

  switch (event.part.kind) {
    case "tool_call": {
      const toolName = getObjectStringValue(event.part.data, "toolName") ?? "unknown"
      const inputText = getObjectStringValue(event.part.data, "inputText") ?? ""
      return `tool.call ${toolName}: ${inputText}\n`
    }
    case "tool_result": {
      const toolName = getObjectStringValue(event.part.data, "toolName") ?? "unknown"
      return `tool.call.completed ${toolName}: ${event.part.text ?? ""}\n`
    }
    case "error":
      return `error ${event.part.text ?? "unknown error"}\n`
    case "step_start":
    case "step_finish":
    case "patch":
      return event.part.text ? `${event.part.kind} ${event.part.text}\n` : ""
  }
}

function renderTextPart(state: CliRenderState, partId: string, text: string | null) {
  if (!text) {
    return ""
  }

  const previousText = state.printedTextByPartId.get(partId) ?? ""
  state.printedTextByPartId.set(partId, text)

  if (text.startsWith(previousText)) {
    return text.slice(previousText.length)
  }

  return text
}

function renderReasoningPart(state: CliRenderState, partId: string, text: string | null) {
  if (!text) {
    return ""
  }

  const previousText = state.printedReasoningByPartId.get(partId) ?? ""
  state.printedReasoningByPartId.set(partId, text)

  const delta = text.startsWith(previousText) ? text.slice(previousText.length) : text
  if (!delta) {
    return ""
  }

  if (previousText.length === 0) {
    return `reasoning> ${delta}`
  }
  return delta
}

function getObjectStringValue(value: unknown, key: string) {
  if (!value || typeof value !== "object") {
    return null
  }

  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === "string" ? candidate : null
}
