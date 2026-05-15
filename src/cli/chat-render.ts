import { relative, resolve } from "node:path"

import type { AppServerNotification, StoredMessage, StoredRun, TimelineEntry } from "../bootstrap"
import type { CliIO } from "./cli-io"
import { formatCompactionBoundaryLine, isCompactionBoundaryPart } from "./compaction-render"

type StoredMessageRole = StoredMessage["role"]
type TimelinePart = TimelineEntry["parts"][number]
const READ_ACTIVITY_IDLE_MS = 150

type ReadActivity = {
  kind: "read"
  files: string[]
}

type ThinkingActivity = {
  kind: "thinking"
  label: string
}

type ToolActivity = {
  kind: "tool"
  toolName: string
  detail: string | null
}

type Activity = ReadActivity | ThinkingActivity | ToolActivity

export type CliChatRenderState = {
  renderedRunStatuses: Map<string, Set<StoredRun["status"]>>
  messageRoles: Map<string, StoredMessageRole>
  printedTextByPartId: Map<string, string>
  renderedPartIds: Set<string>
  assistantLineOpen: boolean
  activeActivity: Activity | null
  activeActivityVisible: boolean
  activeActivityRevealOnComplete: boolean
  readActivityTimeout: ReturnType<typeof setTimeout> | null
}

export function createCliChatRenderState(): CliChatRenderState {
  return {
    renderedRunStatuses: new Map<string, Set<StoredRun["status"]>>(),
    messageRoles: new Map<string, StoredMessageRole>(),
    printedTextByPartId: new Map<string, string>(),
    renderedPartIds: new Set<string>(),
    assistantLineOpen: false,
    activeActivity: null,
    activeActivityVisible: false,
    activeActivityRevealOnComplete: false,
    readActivityTimeout: null,
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

  function clearReadActivityTimeout() {
    if (!state.readActivityTimeout) {
      return
    }

    clearTimeout(state.readActivityTimeout)
    state.readActivityTimeout = null
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

  function scheduleReadActivityFlush() {
    clearReadActivityTimeout()

    if (!state.activeActivityVisible || state.activeActivity?.kind !== "read") {
      return
    }

    state.readActivityTimeout = setTimeout(() => {
      if (state.activeActivity?.kind !== "read") {
        return
      }

      finalizeActivity()
    }, READ_ACTIVITY_IDLE_MS)
  }

  function finalizeActivity(resultText?: string | null) {
    if (!state.activeActivity) {
      return
    }

    clearReadActivityTimeout()

    const activity = state.activeActivity
    const visible = state.activeActivityVisible || (state.activeActivityRevealOnComplete && resultText != null)
    state.activeActivity = null
    state.activeActivityVisible = false
    state.activeActivityRevealOnComplete = false

    if (!visible) {
      return
    }

    if (activity.kind === "read") {
      finishStatus(describeReadActivity(activity.files, "final"))
      return
    }

    if (activity.kind === "thinking") {
      finishStatus(activity.label)
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
    part: Extract<AppServerNotification, { type: "timeline.part.updated" }>["part"],
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

        if (state.activeActivityVisible) {
          updateStatus(describeReadActivity(state.activeActivity.files, "live"))
        }
        scheduleReadActivityFlush()
        return
      }

      finalizeActivity()
      state.activeActivity = {
        kind: "read",
        files: [filePath],
      }
      state.activeActivityVisible = true
      state.activeActivityRevealOnComplete = false
      startStatus(describeReadActivity(state.activeActivity.files, "live"))
      scheduleReadActivityFlush()
      return
    }

    finalizeActivity()
    const detail = extractToolDetail(toolName, inputText)
    state.activeActivity = {
      kind: "tool",
      toolName,
      detail,
    }
    state.activeActivityVisible = true
    state.activeActivityRevealOnComplete = false
    startStatus(describeToolActivity(toolName, detail, null, "live"))
  }

  function handleToolResult(
    part: Extract<AppServerNotification, { type: "timeline.part.updated" }>["part"],
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

    if (run.status === "running") {
      if (!state.activeActivity && !state.assistantLineOpen) {
        state.activeActivity = {
          kind: "thinking",
          label: describeRunningStatus(run.trigger),
        }
        state.activeActivityVisible = true
        startStatus(describeRunningStatus(run.trigger))
      }
      return
    }

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

  function describeRunningStatus(trigger: StoredRun["trigger"]) {
    return trigger === "command" ? "compacting session" : "thinking"
  }

  function seedTimelineState(timeline: TimelineEntry[]) {
    for (const message of timeline) {
      state.messageRoles.set(message.id, message.role)

      if (message.role !== "assistant") {
        if (message.role !== "compaction") {
          continue
        }
      }

      for (const part of message.parts) {
        if (part.kind === "compaction_boundary") {
          continue
        }

        if (message.role === "compaction") {
          continue
        }

        if (part.kind === "text") {
          state.printedTextByPartId.set(part.id, part.text ?? "")
          continue
        }

        state.renderedPartIds.add(part.id)
      }
    }
  }

  function replayTimelineHistory(inputValue: {
    timeline: TimelineEntry[]
    omittedAssistantMessageIds: Set<string>
  }) {
    let replayedActivity: Activity | null = null

    function flushReplayedActivity(resultText?: string | null) {
      if (!replayedActivity) {
        return
      }

      if (replayedActivity.kind === "read") {
        finishStatus(describeReadActivity(replayedActivity.files, "final"))
        replayedActivity = null
        return
      }

      if (resultText == null) {
        replayedActivity = null
        return
      }

      if (replayedActivity.kind === "tool") {
        finishStatus(
          describeToolActivity(replayedActivity.toolName, replayedActivity.detail, resultText, "final"),
        )
      }
      replayedActivity = null
    }

    for (const message of inputValue.timeline) {
      if (message.role === "user") {
        flushReplayedActivity()
        const text = message.parts
          .filter((part) => part.kind === "text")
          .map((part) => part.text ?? "")
          .join("")
          .trim()

        if (text) {
          write(`you> ${text}\n`)
        }

        continue
      }

      if (
        (message.role !== "assistant" && message.role !== "compaction") ||
        inputValue.omittedAssistantMessageIds.has(message.id)
      ) {
        continue
      }

      const hasCompactionBoundary = message.parts.some(isCompactionBoundaryPart)
      if (hasCompactionBoundary) {
        flushReplayedActivity()
        const boundaryPart = message.parts.find(isCompactionBoundaryPart)
        if (boundaryPart) {
          closeAssistantLine()
          write(formatCompactionBoundaryLine(boundaryPart.data))
        }
      }

      let assistantText = ""

      for (const part of message.parts) {
        if (part.kind === "compaction_boundary") {
          continue
        }

        if (message.role === "compaction") {
          if (part.kind === "error") {
            flushReplayedActivity()
            closeAssistantLine()
            write(`error> ${part.text ?? "unknown error"}\n`)
          }
          continue
        }

        if (part.kind === "text" && part.text) {
          flushReplayedActivity()
          assistantText += part.text
          continue
        }

        if (part.kind === "tool_call") {
          if (assistantText) {
            write(`assistant> ${assistantText}\n`)
            assistantText = ""
          }

          const nextActivity = buildHydratedToolActivity(part, replayedActivity)

          if (replayedActivity?.kind === "read" && nextActivity.kind !== "read") {
            flushReplayedActivity()
          }

          replayedActivity = nextActivity
          continue
        }

        if (part.kind === "tool_result") {
          if (assistantText) {
            write(`assistant> ${assistantText}\n`)
            assistantText = ""
          }

          const toolName = getObjectStringValue(part.data, "toolName") ?? "unknown"

          if (
            replayedActivity?.kind === "tool" &&
            replayedActivity.toolName === toolName
          ) {
            flushReplayedActivity(part.text)
            continue
          }

          if (replayedActivity?.kind === "read") {
            continue
          }

          continue
        }

        if (part.kind !== "error") {
          continue
        }

        if (assistantText) {
          write(`assistant> ${assistantText}\n`)
          assistantText = ""
        }

        flushReplayedActivity()
        write(`error> ${part.text ?? "unknown error"}\n`)
      }

      if (assistantText) {
        write(`assistant> ${assistantText}\n`)
      }
    }

    if (replayedActivity?.kind === "read") {
      flushReplayedActivity()
    }
  }

  function buildHydratedToolActivity(
    part: TimelinePart,
    currentActivity: Activity | null,
  ): Activity {
    const toolName = getObjectStringValue(part.data, "toolName") ?? "unknown"
    const inputText = getObjectStringValue(part.data, "inputText") ?? part.text ?? ""

    if (toolName === "read") {
      const filePath = formatWorkspacePath(
        input.workspaceRoot,
        extractToolDetail(toolName, inputText) ?? "<unknown>",
      )

      if (currentActivity?.kind === "read") {
        if (!currentActivity.files.includes(filePath)) {
          currentActivity.files.push(filePath)
        }

        return currentActivity
      }

      return {
        kind: "read",
        files: [filePath],
      }
    }

    return {
      kind: "tool",
      toolName,
      detail: extractToolDetail(toolName, inputText),
    }
  }

  function replayActiveRunSnapshot(inputValue: {
    timeline: TimelineEntry[]
    runId: string
    runTrigger: StoredRun["trigger"]
    renderLiveActivity: boolean
  }) {
    let resumedText: string | null = null
    let resumedActivity: Activity | null = null

    for (const message of inputValue.timeline) {
      if (
        message.producedByRunId !== inputValue.runId ||
        (message.role !== "assistant" && message.role !== "compaction")
      ) {
        continue
      }

      for (const part of message.parts) {
        if (part.kind === "compaction_boundary") {
          resumedText = null
          resumedActivity = null
          continue
        }

        if (message.role === "compaction") {
          continue
        }

        switch (part.kind) {
          case "text":
            resumedText = part.text ?? ""
            resumedActivity = null
            continue
          case "tool_call":
            resumedText = null
            resumedActivity = buildHydratedToolActivity(part, resumedActivity)
            continue
          case "tool_result":
            if (
              resumedActivity?.kind === "tool" &&
              resumedActivity.toolName === (getObjectStringValue(part.data, "toolName") ?? "unknown")
            ) {
              resumedActivity = null
            }

            resumedText = null
            continue
          case "error":
            resumedText = null
            resumedActivity = null
            continue
          case "reasoning":
          case "step_start":
          case "step_finish":
          case "patch":
            continue
        }
      }
    }

    if (resumedText) {
      write(`assistant> ${resumedText}`)
      state.assistantLineOpen = true
    }

    if (!resumedActivity) {
      if (!resumedText && inputValue.renderLiveActivity) {
        state.activeActivity = {
          kind: "thinking",
          label: describeRunningStatus(inputValue.runTrigger),
        }
        state.activeActivityVisible = true
        startStatus(describeRunningStatus(inputValue.runTrigger))
      }

      return
    }

    state.activeActivity = resumedActivity
    state.activeActivityVisible = inputValue.renderLiveActivity
    state.activeActivityRevealOnComplete = !inputValue.renderLiveActivity

    if (!inputValue.renderLiveActivity) {
      return
    }

    if (resumedActivity.kind === "read") {
      startStatus(describeReadActivity(resumedActivity.files, "live"))
      scheduleReadActivityFlush()
      return
    }

    if (resumedActivity.kind === "tool") {
      startStatus(describeToolActivity(resumedActivity.toolName, resumedActivity.detail, null, "live"))
    }
  }

  return {
    hydrateTimeline(inputValue: {
      timeline: TimelineEntry[]
      activeRunId?: string
      activeRunTrigger?: StoredRun["trigger"]
      renderLiveActivity?: boolean
    }) {
      seedTimelineState(inputValue.timeline)
      const omittedAssistantMessageIds = new Set<string>()

      if (inputValue.activeRunId) {
        const lastActiveAssistantMessage = [...inputValue.timeline]
          .reverse()
          .find(
            (message) =>
              message.producedByRunId === inputValue.activeRunId && message.role === "assistant",
          )

        if (lastActiveAssistantMessage) {
          omittedAssistantMessageIds.add(lastActiveAssistantMessage.id)
        }
      }

      replayTimelineHistory({
        timeline: inputValue.timeline,
        omittedAssistantMessageIds,
      })

      if (!inputValue.activeRunId) {
        return
      }

      replayActiveRunSnapshot({
        timeline: inputValue.timeline,
        runId: inputValue.activeRunId,
        runTrigger: inputValue.activeRunTrigger ?? "prompt",
        renderLiveActivity: inputValue.renderLiveActivity ?? false,
      })
    },
    renderNotification(event: AppServerNotification) {
      switch (event.type) {
        case "heartbeat":
        case "session.created":
        case "session.updated":
        case "context.usage.updated":
        case "permission.updated":
        case "run.created":
          return
        case "run.updated":
          renderRunStatus(event.run)
          return
        case "timeline.entry.created":
          state.messageRoles.set(event.entry.id, event.entry.role)
          return
        case "permission.requested":
          finalizeActivity()
          closeAssistantLine()
          return
        case "timeline.part.updated": {
          const role = state.messageRoles.get(event.part.entryId)
          if (role !== "assistant" && role !== "compaction") {
            return
          }

          if (isCompactionBoundaryPart(event.part)) {
            finalizeActivity()
            closeAssistantLine()
            write(formatCompactionBoundaryLine(event.part.data))
            return
          }

          if (role === "compaction") {
            if (event.part.kind === "error") {
              finalizeActivity()
              closeAssistantLine()
              write(`error> ${event.part.text ?? "unknown error"}\n`)
            }
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
      }
    },
    finish() {
      clearReadActivityTimeout()
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

  if (text.startsWith(previousText)) {
    state.printedTextByPartId.set(partId, text)
    return text.slice(previousText.length)
  }

  if (previousText.startsWith(text)) {
    return ""
  }

  state.printedTextByPartId.set(partId, text)
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
