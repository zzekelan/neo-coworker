import type {
  OrchestrationSessionPort,
  OrchestrationPartRecord,
  OrchestrationTranscriptMessage,
} from "./ports/session"
import type { OrchestrationModelPort } from "./ports/model"
import type { OrchestrationSkillPort } from "./ports/skill"
import type { OrchestrationToolPort } from "./ports/tool"
import type { RuntimeEvent } from "./event"

type OrchestrationEventEmitter = (event: RuntimeEvent) => void

type CreateOrchestrationStepServiceInput = {
  session: OrchestrationSessionPort
  model: OrchestrationModelPort
  skill: OrchestrationSkillPort
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

type ToolCallOutcome = "continue" | "cancel"
type StepOutcome = "repeat" | "complete" | "failed" | "cancelled"

type AssistantError = {
  text: string
  data?: unknown
}

const MODEL_REQUEST_MAX_ATTEMPTS = 3

function isAbortError(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof Error && error.name === "AbortError")
}

function isDetachedError(error: unknown) {
  return error instanceof Error && error.name === "RunDetachedError"
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function createAbortError(message = "Operation aborted") {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

function isToolPermissionDeniedError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  return error.name === "ToolPermissionDeniedError"
}

function isTerminalRunStatus(status: string) {
  return status === "completed" || status === "failed" || status === "cancelled"
}

async function readNextModelEvent<T>(input: {
  iterator: AsyncIterator<T>
  signal: AbortSignal
}) {
  const nextValue = input.iterator.next()
  if (input.signal.aborted) {
    const drained = await drainAlreadyProducedModelEvent(nextValue)
    if (drained && !drained.done) {
      void Promise.resolve(input.iterator.return?.()).catch(() => {})
      return drained
    }

    void Promise.resolve(input.iterator.return?.()).catch(() => {})
    throw createAbortError()
  }

  let aborted = false
  let rejectAbort: ((error: Error) => void) | null = null
  const abortedPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => {
    aborted = true
    rejectAbort?.(createAbortError())
  }

  input.signal.addEventListener("abort", onAbort, { once: true })

  try {
    return await Promise.race([nextValue, abortedPromise])
  } catch (error) {
    if (!aborted) {
      throw error
    }

    const drained = await drainAlreadyProducedModelEvent(nextValue)
    if (drained && !drained.done) {
      void Promise.resolve(input.iterator.return?.()).catch(() => {})
      return drained
    }

    void Promise.resolve(input.iterator.return?.()).catch(() => {})
    throw createAbortError()
  } finally {
    input.signal.removeEventListener("abort", onAbort)
  }
}

async function drainAlreadyProducedModelEvent<T>(nextValue: Promise<IteratorResult<T>>) {
  const result = await Promise.race([
    nextValue.then(
      (value) =>
        ({
          kind: "value" as const,
          value,
        }),
      (error) =>
        ({
          kind: "error" as const,
          error,
        }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) => {
      setTimeout(() => {
        resolve({ kind: "timeout" })
      }, 0)
    }),
  ])

  if (result.kind === "value") {
    return result.value
  }

  if (result.kind === "error") {
    throw result.error
  }

  void nextValue.catch(() => {})
  return null
}

function shouldRetryModelRequest(input: {
  attempt: number
  sawProviderOutput: boolean
}) {
  return !input.sawProviderOutput && input.attempt < MODEL_REQUEST_MAX_ATTEMPTS
}

export function createOrchestrationStepService(input: CreateOrchestrationStepServiceInput) {
  const now = input.now ?? Date.now

  return {
    isAbortError,
    isDetachedError,
    getErrorMessage,
    initializeRun(runInput: {
      sessionId: string
      runId: string
      emit: OrchestrationEventEmitter
    }) {
      const run = input.session.getRun(runInput.runId)
      if (run.sessionId !== runInput.sessionId) {
        throw new Error(`Run ${runInput.runId} does not belong to session ${runInput.sessionId}`)
      }
      if (run.status !== "queued") {
        throw new Error(`Run ${runInput.runId} cannot start from status ${run.status}`)
      }

      input.session.transitionRunToRunning(runInput.runId)
      runInput.emit({ type: "run.started", runId: runInput.runId })
      runInput.emit({
        type: "skill.run.snapshot.applied",
        activeSkillNames: run.activeSkills,
        activeSkillCount: run.activeSkills.length,
      })
    },
    completeRun(runInput: {
      runId: string
      emit: OrchestrationEventEmitter
    }) {
      input.session.completeRun(runInput.runId)
      runInput.emit({ type: "run.completed", runId: runInput.runId })
    },
    failRun(runInput: {
      runId: string
      error: string
      emit: OrchestrationEventEmitter
    }) {
      input.session.failRun({
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
      const run = input.session.getRun(runInput.runId)
      if (run.status === "cancelled" || isTerminalRunStatus(run.status)) {
        return false
      }

      input.session.cancelRun(runInput.runId)
      runInput.emit?.({ type: "run.cancelled", runId: runInput.runId })
      return true
    },
    async executeStep(stepInput: ExecuteOrchestrationStepInput): Promise<
      | {
          status: Extract<StepOutcome, "repeat" | "complete" | "cancelled">
        }
      | {
          status: Extract<StepOutcome, "failed">
          error: string
        }
    > {
      const transcript = input.session.listTranscript(stepInput.sessionId)
      const run = input.session.getRun(stepInput.runId)
      const turnKey = createTurnKey(stepInput.runId, getNextMessageSequence(transcript, stepInput.runId))
      const skillCatalog = await input.skill.listCatalog(stepInput.workspaceRoot)
      stepInput.emit({
        type: "skill.catalog.exposed",
        catalogSkillNames: skillCatalog.map((skill) => skill.name),
        catalogSkillCount: skillCatalog.length,
      })
      const activeSkills = []

      for (const skillName of run.activeSkills) {
        stepInput.emit({
          type: "skill.load.requested",
          skillName,
          reason: "prompt",
        })
        const loadedSkill = await input.skill.loadSkill({
          workspaceRoot: stepInput.workspaceRoot,
          name: skillName,
        })
        stepInput.emit({
          type: "skill.load.completed",
          skillName: loadedSkill.name,
          skillPath: loadedSkill.path,
          instructionsLength: loadedSkill.instructions.length,
          reason: "prompt",
        })
        activeSkills.push(loadedSkill)
      }
      const assistantTurn = createAssistantTurnRecorder({
        session: input.session,
        sessionId: stepInput.sessionId,
        runId: stepInput.runId,
        messageSequence: getNextMessageSequence(transcript, stepInput.runId),
        emit: stepInput.emit,
        now,
      })
      let requestedTool = false

      for (let attempt = 1; attempt <= MODEL_REQUEST_MAX_ATTEMPTS; attempt += 1) {
        let sawProviderOutput = false
        let iterator: AsyncIterator<
          Awaited<ReturnType<OrchestrationModelPort["streamTurn"]>> extends AsyncIterable<infer T>
            ? T
            : never
        > | null = null

        try {
          const modelEvents = input.model.streamTurn({
            systemPrompt: stepInput.systemPrompt,
            skillCatalog,
            activeSkills,
            tools: stepInput.tools.list(),
            transcript,
            sessionId: stepInput.sessionId,
            runId: stepInput.runId,
            turnKey,
            signal: stepInput.signal,
          })
          iterator = modelEvents[Symbol.asyncIterator]()

          while (true) {
            const next = await readNextModelEvent({
              iterator,
              signal: stepInput.signal,
            })

            if (next.done) {
              break
            }

            sawProviderOutput = true
            const item = next.value
            if (item.type === "text.delta") {
              assistantTurn.appendText(item.text)
              stepInput.emit({ type: "message.delta", text: item.text })
              if (stepInput.signal.aborted) {
                throw createAbortError()
              }
              continue
            }

            if (item.type === "usage") {
              input.session.recordRunTokenUsage({
                runId: stepInput.runId,
                inputTokens: item.inputTokens,
                outputTokens: item.outputTokens,
                tokenUsageSource: item.source,
              })
              continue
            }

            if (stepInput.signal.aborted) {
              throw createAbortError()
            }

            requestedTool = true
            const outcome = await executeToolCall({
              item,
              assistantTurn,
              emit: stepInput.emit,
              signal: stepInput.signal,
              tools: stepInput.tools,
              workspaceRoot: stepInput.workspaceRoot,
            })

            if (outcome === "cancel") {
              return {
                status: "cancelled" as const,
              }
            }
          }

          break
        } catch (error) {
          if (isAbortError(error, stepInput.signal)) {
            throw error
          }

          if (isDetachedError(error)) {
            throw error
          }

          void iterator?.return?.()

          if (shouldRetryModelRequest({ attempt, sawProviderOutput })) {
            stepInput.emit({
              type: "model.turn.retrying",
              attempt,
              error: getErrorMessage(error),
            })
            continue
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

function createTurnKey(runId: string, messageSequence: number) {
  return `${runId}:turn_${messageSequence}`
}

async function executeToolCall(input: {
  item: ToolCallEvent
  assistantTurn: ReturnType<typeof createAssistantTurnRecorder>
  emit: OrchestrationEventEmitter
  signal: AbortSignal
  tools: OrchestrationToolPort
  workspaceRoot: string
}): Promise<ToolCallOutcome> {
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
    return "continue"
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
    return "continue"
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      throw error
    }

    if (isDetachedError(error)) {
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

    return isToolPermissionDeniedError(error) ? "cancel" : "continue"
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
  session: OrchestrationSessionPort
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

    message = input.session.createAssistantMessage({
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
    const createdPart = input.session.createMessagePart({
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
        input.session.updateMessagePart({
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
