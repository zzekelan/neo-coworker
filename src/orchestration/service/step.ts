import type {
  OrchestrationConversationPort,
  OrchestrationPartRecord,
  OrchestrationTranscriptMessage,
} from "../ports/conversation"
import type { OrchestrationModelPort } from "../ports/model"
import type { OrchestrationToolPort } from "../ports/tool"
import type { OrchestrationEventEmitter } from "./index"

type CreateOrchestrationStepServiceInput = {
  conversation: OrchestrationConversationPort
  model: OrchestrationModelPort
  now?: () => number
}

type ExecuteOrchestrationStepInput = {
  sessionId: string
  runId: string
  tools: OrchestrationToolPort
  workspaceRoot: string
  systemPrompt: string
  signal: AbortSignal
  emit: OrchestrationEventEmitter
}

type ToolCallEvent = {
  type: "tool.call"
  callId: string
  name: string
  inputText: string
}

type AssistantError = {
  text: string
  data?: unknown
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

function isTerminalRunStatus(status: string) {
  return status === "completed" || status === "failed" || status === "cancelled"
}

export function createOrchestrationStepService(input: CreateOrchestrationStepServiceInput) {
  const now = input.now ?? Date.now

  return {
    isAbortError,
    getErrorMessage,
    initializeRun(runInput: {
      sessionId: string
      runId: string
      emit: OrchestrationEventEmitter
    }) {
      const run = input.conversation.getRun(runInput.runId)
      if (run.sessionId !== runInput.sessionId) {
        throw new Error(`Run ${runInput.runId} does not belong to session ${runInput.sessionId}`)
      }
      if (run.status !== "queued") {
        throw new Error(`Run ${runInput.runId} cannot start from status ${run.status}`)
      }

      input.conversation.transitionRunToRunning(runInput.runId)
      runInput.emit({ type: "run.started", runId: runInput.runId })
    },
    completeRun(runInput: {
      runId: string
      emit: OrchestrationEventEmitter
    }) {
      input.conversation.completeRun(runInput.runId)
      runInput.emit({ type: "run.completed", runId: runInput.runId })
    },
    failRun(runInput: {
      runId: string
      error: string
      emit: OrchestrationEventEmitter
    }) {
      input.conversation.failRun({
        runId: runInput.runId,
        errorText: runInput.error,
      })
      runInput.emit({
        type: "run.failed",
        runId: runInput.runId,
        error: runInput.error,
      })
    },
    cancelRun(runInput: {
      runId: string
      emit?: OrchestrationEventEmitter
    }) {
      const run = input.conversation.getRun(runInput.runId)
      if (run.status === "cancelled" || isTerminalRunStatus(run.status)) {
        return false
      }

      input.conversation.cancelRun(runInput.runId)
      runInput.emit?.({ type: "run.cancelled", runId: runInput.runId })
      return true
    },
    async executeStep(stepInput: ExecuteOrchestrationStepInput) {
      const transcript = input.conversation.listTranscript(stepInput.sessionId)
      const assistantTurn = createAssistantTurnRecorder({
        conversation: input.conversation,
        sessionId: stepInput.sessionId,
        runId: stepInput.runId,
        messageSequence: getNextMessageSequence(transcript, stepInput.runId),
        emit: stepInput.emit,
        now,
      })
      let requestedTool = false

      try {
        for await (const item of input.model.streamTurn({
          systemPrompt: stepInput.systemPrompt,
          activeSkillInstructions: [],
          tools: stepInput.tools.list(),
          transcript,
          signal: stepInput.signal,
        })) {
          if (item.type === "text.delta") {
            assistantTurn.appendText(item.text)
            stepInput.emit({ type: "message.delta", text: item.text })
            continue
          }

          requestedTool = true
          await executeToolCall({
            item,
            assistantTurn,
            emit: stepInput.emit,
            signal: stepInput.signal,
            tools: stepInput.tools,
            workspaceRoot: stepInput.workspaceRoot,
          })
        }
      } catch (error) {
        if (isAbortError(error, stepInput.signal)) {
          throw error
        }

        const message = getErrorMessage(error)
        assistantTurn.appendError({
          text: message,
          data: { source: "provider" },
        })
        return {
          status: "failed" as const,
          error: message,
        }
      }

      if (stepInput.signal.aborted) {
        throw createAbortError()
      }

      return {
        status: requestedTool ? ("repeat" as const) : ("complete" as const),
      }
    },
  }
}

async function executeToolCall(input: {
  item: ToolCallEvent
  assistantTurn: ReturnType<typeof createAssistantTurnRecorder>
  emit: OrchestrationEventEmitter
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
    input.emit({
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
  transcript: OrchestrationTranscriptMessage[],
  runId: string,
) {
  const highestSequence = transcript
    .filter((message) => message.runId === runId)
    .reduce((value, message) => Math.max(value, message.sequence), -1)

  return highestSequence + 1
}

function createAssistantTurnRecorder(input: {
  conversation: OrchestrationConversationPort
  sessionId: string
  runId: string
  messageSequence: number
  emit: OrchestrationEventEmitter
  now: () => number
}) {
  let message: { id: string } | null = null
  let nextPartSequence = 0
  let activeTextPart: { id: string; text: string } | null = null

  function ensureMessage() {
    if (message) {
      return message
    }

    message = input.conversation.createAssistantMessage({
      sessionId: input.sessionId,
      runId: input.runId,
      sequence: input.messageSequence,
      createdAt: input.now(),
    })
    input.emit({ type: "message.started", role: "assistant" })
    return message
  }

  function createPart(part: {
    kind: string
    text?: string | null
    data?: unknown
  }) {
    const createdPart = input.conversation.createMessagePart({
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: ensureMessage().id,
      kind: part.kind,
      sequence: nextPartSequence,
      text: part.text,
      data: part.data,
      createdAt: input.now(),
    })
    nextPartSequence += 1
    activeTextPart = part.kind === "text" ? readActiveTextPart(createdPart) : null
    return createdPart
  }

  return {
    appendText(text: string) {
      if (activeTextPart) {
        activeTextPart.text += text
        input.conversation.updateMessagePart({
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
    appendToolCall(toolCall: {
      callId: string
      toolName: string
      inputText: string
    }) {
      createPart({
        kind: "tool_call",
        text: toolCall.inputText,
        data: {
          callId: toolCall.callId,
          toolName: toolCall.toolName,
          inputText: toolCall.inputText,
        },
      })
    },
    appendToolResult(toolResult: {
      callId: string
      toolName: string
      output: string
    }) {
      createPart({
        kind: "tool_result",
        text: toolResult.output,
        data: {
          callId: toolResult.callId,
          toolName: toolResult.toolName,
          output: toolResult.output,
        },
      })
    },
    appendError(error: AssistantError) {
      createPart({
        kind: "error",
        text: error.text,
        data: error.data,
      })
    },
  }
}

function readActiveTextPart(part: OrchestrationPartRecord) {
  if (part.kind !== "text") {
    return null
  }

  return {
    id: part.id,
    text: part.text ?? "",
  }
}
