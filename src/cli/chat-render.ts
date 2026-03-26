import { relative, resolve } from "node:path"

import type { ServerEvent, StoredMessage, StoredRun } from "../bootstrap"
import type { CliIO } from "./cli-io"

type StoredMessageRole = StoredMessage["role"]

type ReadActivity = {
  kind: "read"
  files: string[]
}

type ToolActivity = {
  kind: "tool"
  toolName: string
  detail: string | null
}

type Activity = ReadActivity | ToolActivity

export type CliChatRenderState = {
  renderedRunStatuses: Map<string, Set<StoredRun["status"]>>
  messageRoles: Map<string, StoredMessageRole>
  printedTextByPartId: Map<string, string>
  renderedPartIds: Set<string>
  assistantLineOpen: boolean
  activeActivity: Activity | null
}

export function createCliChatRenderState(): CliChatRenderState {
  return {
    renderedRunStatuses: new Map<string, Set<StoredRun["status"]>>(),
    messageRoles: new Map<string, StoredMessageRole>(),
    printedTextByPartId: new Map<string, string>(),
    renderedPartIds: new Set<string>(),
    assistantLineOpen: false,
    activeActivity: null,
  }
}

export function createCliChatRenderer(input: {
  io: CliIO
  workspaceRoot: string
}) {
  const state = createCliChatRenderState()

  function write(text: string) {
    input.io.write(text)
  }

  function startStatus(text: string) {
    if (input.io.startStatus) {
      input.io.startStatus(text)
      return
    }

    write(`| ${text}\n`)
  }

  function updateStatus(text: string) {
    if (input.io.updateStatus) {
      input.io.updateStatus(text)
    }
  }

  function finishStatus(text: string) {
    if (input.io.finishStatus) {
      input.io.finishStatus(text)
      return
    }

    write(`✓ ${text}\n`)
  }

  function closeAssistantLine() {
    if (!state.assistantLineOpen) {
      return
    }

    write("\n")
    state.assistantLineOpen = false
  }

  function finalizeActivity(resultText?: string | null) {
    if (!state.activeActivity) {
      return
    }

    const activity = state.activeActivity
    state.activeActivity = null

    if (activity.kind === "read") {
      finishStatus(describeReadActivity(activity.files, "final"))
      return
    }

    finishStatus(describeToolActivity(activity.toolName, activity.detail, resultText, "final"))
  }

  function renderAssistantText(partId: string, text: string | null) {
    const delta = getTextDelta(state, partId, text)
    if (!delta) {
      return
    }

    finalizeActivity()

    if (!state.assistantLineOpen) {
      write("assistant> ")
      state.assistantLineOpen = true
    }

    write(delta)
  }

  function handleToolCall(
    part: Extract<ServerEvent, { type: "message.part.updated" }>["part"],
  ) {
    const toolName = getObjectStringValue(part.data, "toolName") ?? "unknown"
    const inputText = getObjectStringValue(part.data, "inputText") ?? ""

    closeAssistantLine()

    if (toolName === "read") {
      const filePath = formatWorkspacePath(
        input.workspaceRoot,
        extractToolDetail(toolName, inputText) ?? "<unknown>",
      )

      if (state.activeActivity?.kind === "read") {
        if (!state.activeActivity.files.includes(filePath)) {
          state.activeActivity.files.push(filePath)
        }

        updateStatus(describeReadActivity(state.activeActivity.files, "live"))
        return
      }

      finalizeActivity()
      state.activeActivity = {
        kind: "read",
        files: [filePath],
      }
      startStatus(describeReadActivity(state.activeActivity.files, "live"))
      return
    }

    finalizeActivity()
    const detail = extractToolDetail(toolName, inputText)
    state.activeActivity = {
      kind: "tool",
      toolName,
      detail,
    }
    startStatus(describeToolActivity(toolName, detail, null, "live"))
  }

  function handleToolResult(
    part: Extract<ServerEvent, { type: "message.part.updated" }>["part"],
  ) {
    const toolName = getObjectStringValue(part.data, "toolName") ?? "unknown"

    if (toolName === "read" && state.activeActivity?.kind === "read") {
      return
    }

    if (state.activeActivity?.kind === "tool" && state.activeActivity.toolName === toolName) {
      finalizeActivity(part.text)
    }
  }

  function renderRunStatus(run: StoredRun) {
    let renderedStatuses = state.renderedRunStatuses.get(run.id)
    if (!renderedStatuses) {
      renderedStatuses = new Set<StoredRun["status"]>()
      state.renderedRunStatuses.set(run.id, renderedStatuses)
    }

    if (renderedStatuses.has(run.status)) {
      return
    }

    renderedStatuses.add(run.status)

    if (run.status === "completed") {
      finalizeActivity()
      closeAssistantLine()
      return
    }

    if (run.status === "failed") {
      finalizeActivity()
      closeAssistantLine()
      write(`error> ${run.errorText ?? `run ${run.id} failed`}\n`)
      return
    }

    if (run.status === "cancelled") {
      finalizeActivity()
      closeAssistantLine()
      write("status> cancelled\n")
    }
  }

  return {
    renderUserPrompt(prompt: string) {
      finalizeActivity()
      closeAssistantLine()
      write(`you> ${prompt}\n`)
    },
    renderEvent(event: ServerEvent) {
      switch (event.type) {
        case "heartbeat":
        case "session.created":
        case "session.updated":
        case "permission.updated":
        case "runtime.error":
        case "run.created":
          return
        case "run.updated":
          renderRunStatus(event.run)
          return
        case "message.created":
          state.messageRoles.set(event.message.id, event.message.role)
          return
        case "permission.requested":
          finalizeActivity()
          closeAssistantLine()
          return
        case "message.part.updated":
          if (state.messageRoles.get(event.part.messageId) !== "assistant") {
            return
          }

          if (event.part.kind === "text") {
            renderAssistantText(event.part.id, event.part.text)
            return
          }

          if (state.renderedPartIds.has(event.part.id)) {
            return
          }

          state.renderedPartIds.add(event.part.id)

          switch (event.part.kind) {
            case "tool_call":
              handleToolCall(event.part)
              return
            case "tool_result":
              handleToolResult(event.part)
              return
            case "error":
              finalizeActivity()
              closeAssistantLine()
              write(`error> ${event.part.text ?? "unknown error"}\n`)
              return
            case "reasoning":
            case "step_start":
            case "step_finish":
            case "patch":
              return
          }
      }
    },
    finish() {
      finalizeActivity()
      closeAssistantLine()
    },
  }
}

function getTextDelta(state: CliChatRenderState, partId: string, text: string | null) {
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

function describeReadActivity(files: string[], mode: "live" | "final") {
  const count = files.length
  const noun = count === 1 ? "file" : "files"
  const verb = mode === "live" ? "reading" : "read"

  return `${verb} ${count} ${noun}: ${files.join(" | ")}`
}

function describeToolActivity(
  toolName: string,
  detail: string | null,
  resultText: string | null | undefined,
  mode: "live" | "final",
) {
  if (mode === "live") {
    return detail ? `running ${toolName}: ${detail}` : `running ${toolName}`
  }

  const summary = resultText?.trim() || detail || "done"
  return `${toolName}: ${summary}`
}

function extractToolDetail(toolName: string, inputText: string) {
  const parsed = parseToolInputText(inputText)
  if (!parsed) {
    return null
  }

  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    return getObjectStringValue(parsed, "path")
  }

  if (toolName === "shell") {
    return getObjectStringValue(parsed, "command")
  }

  return null
}

function parseToolInputText(inputText: string) {
  if (!inputText) {
    return null
  }

  try {
    return JSON.parse(inputText) as Record<string, unknown>
  } catch {
    return null
  }
}

function formatWorkspacePath(workspaceRoot: string, filePath: string) {
  if (!filePath) {
    return "<unknown>"
  }

  if (!filePath.startsWith("/")) {
    return filePath
  }

  const relativePath = relative(resolve(workspaceRoot), resolve(filePath))
  if (!relativePath || relativePath.startsWith("..")) {
    return filePath
  }

  return relativePath
}

function getObjectStringValue(value: unknown, key: string) {
  if (!value || typeof value !== "object") {
    return null
  }

  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === "string" ? candidate : null
}
