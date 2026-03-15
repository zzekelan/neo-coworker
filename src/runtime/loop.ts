import { isActiveRunStatus } from "../conversation/service"
import type { createConversationRunService as createSessionRunService } from "../conversation/service"
import type { OrchestrationModelPort } from "../orchestration/ports/model"
import type { OrchestrationToolPort } from "../orchestration/ports/tool"
import type {
  ConversationRepository as StorageRepository,
  StoredMessage,
  StoredPart,
} from "../conversation/repo"
import type { RuntimeEvent } from "./events"
import type { createEventQueue } from "./event-queue"

type SessionRunService = Pick<
  ReturnType<typeof createSessionRunService>,
  "transitionRunToRunning" | "completeRun" | "failRun" | "cancelRun"
>

type AgentLoopInput = {
  sessionId: string
  runId: string
  repository: StorageRepository
  sessionRuns: SessionRunService
  provider: OrchestrationModelPort
  queue: ReturnType<typeof createEventQueue<RuntimeEvent>>
  signal: AbortSignal
  tools: OrchestrationToolPort
  workspaceRoot: string
  systemPrompt: string
  now?: () => number
}

type ToolCallEvent = {
  type: "tool.call"
  callId: string
  name: string
  inputText: string
}

function isAbortError(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof Error && error.name === "AbortError")
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function createAbortError(message = "Operation aborted") {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

export async function runAgentLoop(input: AgentLoopInput) {
  const now = input.now ?? Date.now

  try {
    const run = input.repository.runs.get(input.runId)
    if (run.sessionId !== input.sessionId) {
      throw new Error(`Run ${input.runId} does not belong to session ${input.sessionId}`)
    }
    if (run.status !== "queued") {
      throw new Error(`Run ${input.runId} cannot start from status ${run.status}`)
    }

    input.sessionRuns.transitionRunToRunning(input.runId)
    input.queue.push({ type: "run.started", runId: input.runId })

    while (true) {
      if (input.signal.aborted) {
        cancelRun(input)
        return
      }

      const transcript = input.repository.messages.listSessionTranscript(input.sessionId)
      const assistantTurn = createAssistantTurnRecorder({
        repository: input.repository,
        sessionId: input.sessionId,
        runId: input.runId,
        messageSequence: getNextMessageSequence(transcript, input.runId),
        queue: input.queue,
        now,
      })
      let requestedTool = false

      try {
        for await (const item of input.provider.streamTurn({
          systemPrompt: input.systemPrompt,
          activeSkillInstructions: [],
          tools: input.tools.list(),
          transcript,
          signal: input.signal,
        })) {
          if (item.type === "text.delta") {
            assistantTurn.appendText(item.text)
            input.queue.push({ type: "message.delta", text: item.text })
            continue
          }

          requestedTool = true
          await executeToolCall({
            item,
            assistantTurn,
            queue: input.queue,
            signal: input.signal,
            tools: input.tools,
            workspaceRoot: input.workspaceRoot,
          })
        }
      } catch (error) {
        if (isAbortError(error, input.signal)) {
          cancelRun(input)
          return
        }

        const message = getErrorMessage(error)
        assistantTurn.appendError({
          text: message,
          data: { source: "provider" },
        })
        failRun(input, message)
        return
      }

      if (input.signal.aborted) {
        cancelRun(input)
        return
      }

      if (requestedTool) {
        continue
      }

      input.sessionRuns.completeRun(input.runId)
      input.queue.push({ type: "run.completed", runId: input.runId })
      return
    }
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      cancelRun(input)
      return
    }

    failRun(input, getErrorMessage(error))
  } finally {
    input.queue.close()
  }
}

async function executeToolCall(input: {
  item: ToolCallEvent
  assistantTurn: ReturnType<typeof createAssistantTurnRecorder>
  queue: ReturnType<typeof createEventQueue<RuntimeEvent>>
  signal: AbortSignal
  tools: OrchestrationToolPort
  workspaceRoot: string
}) {
  input.assistantTurn.appendToolCall({
    callId: input.item.callId,
    toolName: input.item.name,
    inputText: input.item.inputText,
  })

  let args: unknown
  try {
    args = JSON.parse(input.item.inputText)
  } catch (error) {
    input.assistantTurn.appendError({
      text: `Malformed tool arguments for ${input.item.name}: ${getErrorMessage(error)}`,
      data: {
        source: "tool",
        callId: input.item.callId,
        toolName: input.item.name,
      },
    })
    return
  }

  try {
    const result = await input.tools.execute({
      toolName: input.item.name,
      args,
      workspaceRoot: input.workspaceRoot,
      signal: input.signal,
    })
    if (input.signal.aborted) {
      throw createAbortError()
    }

    input.assistantTurn.appendToolResult({
      callId: input.item.callId,
      toolName: input.item.name,
      output: result.output,
    })
    input.queue.push({
      type: "tool.call.completed",
      callId: input.item.callId,
      name: input.item.name,
      output: result.output,
    })
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      throw error
    }

    input.assistantTurn.appendError({
      text: `Tool ${input.item.name} failed: ${getErrorMessage(error)}`,
      data: {
        source: "tool",
        callId: input.item.callId,
        toolName: input.item.name,
      },
    })
  }
}

function getNextMessageSequence(
  transcript: ReturnType<StorageRepository["messages"]["listSessionTranscript"]>,
  runId: string,
) {
  const highestSequence = transcript
    .filter((message) => message.runId === runId)
    .reduce((value, message) => Math.max(value, message.sequence), -1)

  return highestSequence + 1
}

function createAssistantTurnRecorder(input: {
  repository: StorageRepository
  sessionId: string
  runId: string
  messageSequence: number
  queue: ReturnType<typeof createEventQueue<RuntimeEvent>>
  now: () => number
}) {
  let message: StoredMessage | null = null
  let nextPartSequence = 0
  let activeTextPart: { id: string; text: string } | null = null

  function ensureMessage() {
    if (message) {
      return message
    }

    message = input.repository.messages.create({
      sessionId: input.sessionId,
      runId: input.runId,
      role: "assistant",
      sequence: input.messageSequence,
      createdAt: input.now(),
    })
    input.queue.push({ type: "message.started", role: "assistant" })
    return message
  }

  function createPart(part: {
    kind: StoredPart["kind"]
    text?: string | null
    data?: unknown
  }) {
    const createdPart = input.repository.parts.create({
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: ensureMessage().id,
      kind: part.kind,
      sequence: nextPartSequence,
      text: part.text ?? null,
      data: part.data,
      createdAt: input.now(),
    })

    nextPartSequence += 1
    activeTextPart = part.kind === "text" ? { id: createdPart.id, text: createdPart.text ?? "" } : null
    return createdPart
  }

  return {
    appendText(text: string) {
      if (activeTextPart) {
        activeTextPart.text += text
        input.repository.parts.updateContent({
          partId: activeTextPart.id,
          text: activeTextPart.text,
        })
        return
      }

      createPart({
        kind: "text",
        text,
      })
    },
    appendToolCall(part: { callId: string; toolName: string; inputText: string }) {
      createPart({
        kind: "tool_call",
        data: part,
      })
    },
    appendToolResult(part: { callId: string; toolName: string; output: string }) {
      createPart({
        kind: "tool_result",
        text: part.output,
        data: part,
      })
    },
    appendError(part: { text: string; data?: unknown }) {
      createPart({
        kind: "error",
        text: part.text,
        data: part.data,
      })
    },
  }
}

function cancelRun(input: AgentLoopInput) {
  const run = input.repository.runs.get(input.runId)
  if (run.status === "cancelled") {
    input.queue.push({ type: "run.cancelled", runId: input.runId })
    return
  }
  if (!isActiveRunStatus(run.status)) {
    throw new Error(`Run ${input.runId} cannot cancel from status ${run.status}`)
  }

  input.sessionRuns.cancelRun(input.runId)
  input.queue.push({ type: "run.cancelled", runId: input.runId })
}

function failRun(input: AgentLoopInput, error: string) {
  const run = input.repository.runs.get(input.runId)
  if (run.status === "running") {
    input.sessionRuns.failRun({
      runId: input.runId,
      errorText: error,
    })
  }

  input.queue.push({
    type: "run.failed",
    runId: input.runId,
    error,
  })
}
