import type {
  OrchestrationSessionPort,
  OrchestrationPartRecord,
  OrchestrationTranscriptMessage,
} from "./ports/session"
import type { OrchestrationModelPort } from "./ports/model"
import type { OrchestrationContextWindowPort } from "./ports/context-window"
import type { OrchestrationSkillPort } from "./ports/skill"
import type { OrchestrationToolPort } from "./ports/tool"
import type { OrchestrationRuntimeObserverPort } from "./ports/runtime-observer"
import type { RuntimeEvent } from "./event"
import {
  buildContextUsageSnapshot,
  DEFAULT_CONTEXT_WINDOW_SIZE,
} from "./context-usage"
import { createRecentFileTracker } from "./recent-file-tracker"
import {
  createSkillReminderTracker,
} from "./skill-reminder-tracker"

type OrchestrationEventEmitter = (event: RuntimeEvent) => void

type CreateOrchestrationStepServiceInput = {
  session: OrchestrationSessionPort
  model: OrchestrationModelPort
  contextWindow: OrchestrationContextWindowPort
  skill: OrchestrationSkillPort
  runtimeObserver?: OrchestrationRuntimeObserverPort
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

type ExecuteCompactionInput = ExecuteOrchestrationStepInput

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
const AUTO_COMPACTION_TOKEN_BUFFER = 12_500
const AUTO_COMPACTION_FAILURE_LIMIT = 3
const SUMMARIZE_RUN_CREATED_AT_OFFSET = 1
const SUMMARY_SECTION_TITLES = [
  "Primary Request",
  "Key Concepts",
  "Files & Code",
  "Errors & Fixes",
  "Problem Solving",
  "User Messages",
  "Pending Tasks",
  "Current Work",
  "Next Steps",
] as const
const COMPACTION_SUMMARY_PROMPT = [
  "Summarize the conversation so the next model turn can continue the same work after context compaction.",
  "Return plain text with exactly these nine section headings, in this order:",
  ...SUMMARY_SECTION_TITLES.map((title) => `- ${title}`),
  "Preserve concrete user intent, decisions, file paths, code changes, failures, pending work, and the current next action.",
  "Do not include an <analysis> block in the final answer.",
].join("\n")

type CompactionMode = "auto" | "manual"

type AutoCompactionResult =
  | {
      compacted: false
    }
  | {
      compacted: true
      boundaryPartId: string
      summarizeRunId: string
      tokensBefore: number
    }

type CompactionProjectionInput = {
  model: OrchestrationModelPort
  systemPrompt: string
  skillCatalog: Awaited<ReturnType<OrchestrationSkillPort["listCatalog"]>>
  activeSkills: ReturnType<ReturnType<typeof createSkillReminderTracker>["resolveActiveSkills"]>
  systemReminders: string[]
  contextWindow: number
  tools: ReturnType<OrchestrationToolPort["list"]>
  transcript: OrchestrationTranscriptMessage[]
  sessionId: string
  runId: string
}

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
  const skillReminders = createSkillReminderTracker()
  const recentFiles = createRecentFileTracker()

  async function loadPendingActiveSkills(inputValue: {
    sessionId: string
    activeSkillNames: readonly string[]
    workspaceRoot: string
    emit: OrchestrationEventEmitter
    reason: "prompt" | "recovery"
  }) {
    const loadedSkills = []

    for (const skillName of skillReminders.listPendingActiveSkillNames(
      inputValue.sessionId,
      inputValue.activeSkillNames,
    )) {
      inputValue.emit({
        type: "skill.load.requested",
        skillName,
        reason: inputValue.reason,
      })
      const loadedSkill = await input.skill.loadSkill({
        workspaceRoot: inputValue.workspaceRoot,
        name: skillName,
      })
      inputValue.emit({
        type: "skill.load.completed",
        skillName: loadedSkill.name,
        skillPath: loadedSkill.path,
        instructionsLength: loadedSkill.instructions.length,
        reason: inputValue.reason,
      })
      loadedSkills.push(loadedSkill)
    }

    skillReminders.injectActiveSkills({
      sessionId: inputValue.sessionId,
      skills: loadedSkills,
      reason: inputValue.reason,
    })
  }

  async function recoverCompactedContext(inputValue: {
    sessionId: string
    workspaceRoot: string
    emit: OrchestrationEventEmitter
  }) {
    const session = input.session.getSession(inputValue.sessionId)
    await loadPendingActiveSkills({
      sessionId: inputValue.sessionId,
      activeSkillNames: session.activeSkills,
      workspaceRoot: inputValue.workspaceRoot,
      emit: inputValue.emit,
      reason: "recovery",
    })

    const recentFileReminder = recentFiles.buildRecoveryReminder(inputValue.sessionId)
    if (recentFileReminder) {
      skillReminders.appendRecoveryReminder({
        sessionId: inputValue.sessionId,
        text: recentFileReminder.text,
        filePaths: recentFileReminder.filePaths,
      })
    }
  }

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
      const contextWindow = input.contextWindow.getContextWindow() || DEFAULT_CONTEXT_WINDOW_SIZE
      let transcript = input.session.listTranscript(stepInput.sessionId)
      const run = input.session.getRun(stepInput.runId)
      const skillCatalog = await input.skill.listCatalog(stepInput.workspaceRoot)
      const availableTools = stepInput.tools.list()
      const exposedCatalogSkillNames = skillReminders.exposeCatalog(stepInput.sessionId, skillCatalog)
      if (exposedCatalogSkillNames.length > 0) {
        stepInput.emit({
          type: "skill.catalog.exposed",
          catalogSkillNames: exposedCatalogSkillNames,
          catalogSkillCount: exposedCatalogSkillNames.length,
        })
      }
      const sessionActiveSkills = input.session.getSession(stepInput.sessionId).activeSkills
      await loadPendingActiveSkills({
        sessionId: stepInput.sessionId,
        activeSkillNames: sessionActiveSkills,
        workspaceRoot: stepInput.workspaceRoot,
        emit: stepInput.emit,
        reason: "prompt",
      })

      const autoCompaction = await maybeAutoCompact({
        session: input.session,
        model: input.model,
        runtimeObserver: input.runtimeObserver,
        skillReminders,
        contextWindow,
        sessionId: stepInput.sessionId,
        run,
        transcript,
        systemPrompt: stepInput.systemPrompt,
        skillCatalog,
        tools: availableTools,
        signal: stepInput.signal,
        emit: stepInput.emit,
        now,
      })
      if (autoCompaction.compacted) {
        skillReminders.resetAfterCompaction(stepInput.sessionId)
        await recoverCompactedContext({
          sessionId: stepInput.sessionId,
          workspaceRoot: stepInput.workspaceRoot,
          emit: stepInput.emit,
        })
        transcript = input.session.listTranscript(stepInput.sessionId)
      }
      transcript = input.session.listTranscript(stepInput.sessionId)
      const activeSkills = skillReminders.resolveActiveSkills(stepInput.sessionId, sessionActiveSkills)
      const systemReminderBatch = skillReminders.consumeSystemReminderBatch(stepInput.sessionId)
      const systemReminders = systemReminderBatch?.messages ?? []
      if (autoCompaction.compacted) {
        const tokensAfter = input.model.projectTurn?.({
          systemPrompt: stepInput.systemPrompt,
          skillCatalog,
          activeSkills,
          systemReminders,
          contextWindow,
          tools: availableTools,
          transcript,
          sessionId: stepInput.sessionId,
          runId: stepInput.runId,
          turnKey: createTurnKey(stepInput.runId, getNextMessageSequence(transcript, stepInput.runId)),
        }).inputTokens
        const compressionRatio = calculateCompressionRatio(autoCompaction.tokensBefore, tokensAfter ?? 0)
        input.session.updateMessagePart({
          partId: autoCompaction.boundaryPartId,
          data: {
            tokensBefore: autoCompaction.tokensBefore,
            tokensAfter: tokensAfter ?? 0,
            compressionRatio,
            summarizeRunId: autoCompaction.summarizeRunId,
            trigger: "auto",
          },
        })
        stepInput.emit({
          type: "compaction.completed",
          trigger: "auto",
          summarizeRunId: autoCompaction.summarizeRunId,
          tokensBefore: autoCompaction.tokensBefore,
          tokensAfter: tokensAfter ?? 0,
          compressionRatio,
        })
      }

      const turnKey = createTurnKey(stepInput.runId, getNextMessageSequence(transcript, stepInput.runId))
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
          systemReminders,
          systemReminderMetadata: systemReminderBatch && {
            catalogSkillNames: systemReminderBatch.catalogSkillNames,
            activeSkillNames: systemReminderBatch.activeSkillNames,
            recoveryFilePaths: systemReminderBatch.recoveryFilePaths,
          },
          contextWindow,
          tools: availableTools,
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
              const contextUsage = buildContextUsageSnapshot({
                contextTokens: item.inputTokens + item.outputTokens,
                contextWindow,
                source: item.source,
              })
              stepInput.emit({
                type: "context.usage.updated",
                sessionId: stepInput.sessionId,
                runId: stepInput.runId,
                ...contextUsage,
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
              sessionId: stepInput.sessionId,
              signal: stepInput.signal,
              recentFiles,
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
    async compactSession(compactionInput: ExecuteCompactionInput): Promise<
      | {
          status: "completed" | "cancelled"
        }
      | {
          status: "failed"
          error: string
        }
    > {
      const contextWindow = input.contextWindow.getContextWindow() || DEFAULT_CONTEXT_WINDOW_SIZE
      const run = input.session.getRun(compactionInput.runId)
      const skillCatalog = await input.skill.listCatalog(compactionInput.workspaceRoot)
      const availableTools = compactionInput.tools.list()
      const transcript = input.session.listTranscript(compactionInput.sessionId)

      if (!input.model.projectTurn) {
        const error = "Manual compaction is unavailable because token projection is not configured."
        appendCompactionFailureArtifacts({
          session: input.session,
          sessionId: compactionInput.sessionId,
          runId: compactionInput.runId,
          trigger: "manual",
          error,
          attemptCount: 1,
          summarizeRunId: null,
          emit: compactionInput.emit,
          now,
        })
        return {
          status: "failed",
          error,
        }
      }

      if (transcript.length === 0) {
        const error = "Session has no transcript to compact."
        appendCompactionFailureArtifacts({
          session: input.session,
          sessionId: compactionInput.sessionId,
          runId: compactionInput.runId,
          trigger: "manual",
          error,
          attemptCount: 1,
          summarizeRunId: null,
          emit: compactionInput.emit,
          now,
        })
        return {
          status: "failed",
          error,
        }
      }

      const projectedBefore = projectCompactionInputTokens({
        model: input.model,
        systemPrompt: compactionInput.systemPrompt,
        skillCatalog,
        activeSkills: skillReminders.resolveActiveSkills(compactionInput.sessionId, run.activeSkills),
        systemReminders: skillReminders.peekSystemReminderBatch(compactionInput.sessionId)?.messages ?? [],
        contextWindow,
        tools: availableTools,
        transcript,
        sessionId: compactionInput.sessionId,
        runId: compactionInput.runId,
      })

      try {
        const manualCompaction = await performCompactionRun({
          session: input.session,
          model: input.model,
          runtimeObserver: input.runtimeObserver,
          contextWindow,
          sessionId: compactionInput.sessionId,
          run,
          transcript,
          signal: compactionInput.signal,
          now,
          tokensBefore: projectedBefore.inputTokens,
          trigger: "manual",
        })
        skillReminders.resetAfterCompaction(compactionInput.sessionId)
        await recoverCompactedContext({
          sessionId: compactionInput.sessionId,
          workspaceRoot: compactionInput.workspaceRoot,
          emit: compactionInput.emit,
        })
        const compactedTranscript = input.session.listTranscript(compactionInput.sessionId)
        const sessionActiveSkills = input.session.getSession(compactionInput.sessionId).activeSkills
        const projectionAfter = projectCompactionInputTokens({
          model: input.model,
          systemPrompt: compactionInput.systemPrompt,
          skillCatalog,
          activeSkills: skillReminders.resolveActiveSkills(
            compactionInput.sessionId,
            sessionActiveSkills,
          ),
          systemReminders: skillReminders.peekSystemReminderBatch(compactionInput.sessionId)?.messages ?? [],
          contextWindow,
          tools: availableTools,
          transcript: compactedTranscript,
          sessionId: compactionInput.sessionId,
          runId: compactionInput.runId,
        })
        input.session.updateMessagePart({
          partId: manualCompaction.boundaryPartId,
          data: {
            tokensBefore: manualCompaction.tokensBefore,
            tokensAfter: projectionAfter.inputTokens,
            compressionRatio: calculateCompressionRatio(
              manualCompaction.tokensBefore,
              projectionAfter.inputTokens,
            ),
            summarizeRunId: manualCompaction.summarizeRunId,
            trigger: "manual",
          },
        })
        compactionInput.emit({
          type: "compaction.completed",
          trigger: "manual",
          summarizeRunId: manualCompaction.summarizeRunId,
          tokensBefore: manualCompaction.tokensBefore,
          tokensAfter: projectionAfter.inputTokens,
          compressionRatio: calculateCompressionRatio(
            manualCompaction.tokensBefore,
            projectionAfter.inputTokens,
          ),
        })
        compactionInput.emit({
          type: "context.usage.updated",
          sessionId: compactionInput.sessionId,
          runId: compactionInput.runId,
          ...buildContextUsageSnapshot({
            contextTokens: projectionAfter.inputTokens,
            contextWindow,
            source: "estimated",
          }),
        })
        return {
          status: "completed",
        }
      } catch (error) {
        if (isAbortError(error, compactionInput.signal)) {
          return {
            status: "cancelled",
          }
        }

        if (isDetachedError(error)) {
          throw error
        }

        const message = getErrorMessage(error)
        appendCompactionFailureArtifacts({
          session: input.session,
          sessionId: compactionInput.sessionId,
          runId: compactionInput.runId,
          trigger: "manual",
          error: message,
          attemptCount: 1,
          summarizeRunId: readCompactionSummarizeRunId(error),
          emit: compactionInput.emit,
          now,
        })
        return {
          status: "failed",
          error: message,
        }
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
  sessionId: string
  signal: AbortSignal
  recentFiles: ReturnType<typeof createRecentFileTracker>
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
      onProgress: (message: string) => {
        input.emit({
          type: "tool.progress",
          toolCallId: input.item.callId,
          message,
          timestamp: Date.now(),
        })
      },
    })
    if (input.signal.aborted) {
      throw createAbortError()
    }

    input.assistantTurn.appendToolResult({
      callId: input.item.callId,
      toolName: input.item.name,
      output: result.output,
      isError: result.isError,
      metadata: result.metadata,
    })
    input.emit({
      type: "tool.call.completed",
      callId: input.item.callId,
      name: input.item.name,
      output: result.output,
    })
    if (input.item.name === "read") {
      const readArgs = readObject(args)
      const path = readString(readArgs, "path")
      if (path) {
        input.recentFiles.recordRead({
          sessionId: input.sessionId,
          path,
          content: result.output,
        })
      }
    }
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
      isError?: boolean
      metadata?: Record<string, unknown>
    }) {
      createPart({
        kind: "tool_result",
        text: toolResult.output,
        data: {
          callId: toolResult.callId,
          toolName: toolResult.toolName,
          output: toolResult.output,
          isError: toolResult.isError,
          metadata: toolResult.metadata,
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

async function maybeAutoCompact(input: {
  session: OrchestrationSessionPort
  model: OrchestrationModelPort
  runtimeObserver?: OrchestrationRuntimeObserverPort
  skillReminders: ReturnType<typeof createSkillReminderTracker>
  contextWindow: number
  sessionId: string
  run: ReturnType<OrchestrationSessionPort["getRun"]>
  transcript: OrchestrationTranscriptMessage[]
  systemPrompt: string
  skillCatalog: Awaited<ReturnType<OrchestrationSkillPort["listCatalog"]>>
  tools: ReturnType<OrchestrationToolPort["list"]>
  signal: AbortSignal
  emit: OrchestrationEventEmitter
  now: () => number
}): Promise<AutoCompactionResult> {
  if (!input.model.projectTurn) {
    return { compacted: false }
  }

  const projected = input.model.projectTurn({
    systemPrompt: input.systemPrompt,
    skillCatalog: input.skillCatalog,
    activeSkills: input.skillReminders.resolveActiveSkills(input.sessionId, input.run.activeSkills),
    systemReminders: input.skillReminders.peekSystemReminderBatch(input.sessionId)?.messages ?? [],
    contextWindow: input.contextWindow,
    tools: input.tools,
    transcript: input.transcript,
    sessionId: input.sessionId,
    runId: input.run.id,
    turnKey: createTurnKey(input.run.id, getNextMessageSequence(input.transcript, input.run.id)),
  })

  if (!shouldAutoCompact(projected.inputTokens, input.contextWindow)) {
    return { compacted: false }
  }

  const breakerState = readAutoCompactionState(input.transcript)
  if (breakerState.open) {
    return { compacted: false }
  }

  try {
    const syntheticMessage = await performCompactionRun({
      session: input.session,
      model: input.model,
      runtimeObserver: input.runtimeObserver,
      contextWindow: input.contextWindow,
      sessionId: input.sessionId,
      run: input.run,
      transcript: input.transcript,
      signal: input.signal,
      now: input.now,
      tokensBefore: projected.inputTokens,
      trigger: "auto",
    })
    return {
      compacted: true,
      boundaryPartId: syntheticMessage.boundaryPartId,
      summarizeRunId: syntheticMessage.summarizeRunId,
      tokensBefore: projected.inputTokens,
    }
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      throw error
    }

    if (isDetachedError(error)) {
      throw error
    }

    const errorText = getErrorMessage(error)
    const attemptCount = breakerState.consecutiveFailures + 1
    appendCompactionFailureArtifacts({
      session: input.session,
      sessionId: input.sessionId,
      runId: input.run.id,
      trigger: "auto",
      error: errorText,
      attemptCount,
      summarizeRunId: readCompactionSummarizeRunId(error),
      emit: input.emit,
      now: input.now,
    })

    if (attemptCount >= AUTO_COMPACTION_FAILURE_LIMIT) {
      const breakerText =
        "⚠️ Automatic compaction has been paused. Run /compact successfully to re-enable it."
      appendSyntheticMessageParts({
        session: input.session,
        sessionId: input.sessionId,
        runId: input.run.id,
        now: input.now,
        parts: [
          {
            kind: "error",
            text: breakerText,
            data: {
              source: "compaction",
              eventType: "compaction.circuit_breaker.triggered",
              consecutiveFailures: attemptCount,
              lastError: errorText,
              resolution: "manual_compact",
            },
          },
        ],
      })
      input.emit({
        type: "compaction.circuit_breaker.triggered",
        consecutiveFailures: attemptCount,
        lastError: errorText,
        resolution: "manual_compact",
      })
    }

    return {
      compacted: false,
    }
  }
}

class CompactionRunError extends Error {
  readonly summarizeRunId: string

  constructor(input: { message: string; summarizeRunId: string }) {
    super(input.message)
    this.name = "CompactionRunError"
    this.summarizeRunId = input.summarizeRunId
  }
}

function projectCompactionInputTokens(input: CompactionProjectionInput) {
  return input.model.projectTurn?.({
    systemPrompt: input.systemPrompt,
    skillCatalog: input.skillCatalog,
    activeSkills: input.activeSkills,
    systemReminders: input.systemReminders,
    contextWindow: input.contextWindow,
    tools: input.tools,
    transcript: input.transcript,
    sessionId: input.sessionId,
    runId: input.runId,
    turnKey: createTurnKey(input.runId, getNextMessageSequence(input.transcript, input.runId)),
  }) ?? { inputTokens: 0 }
}

async function performCompactionRun(input: {
  session: OrchestrationSessionPort
  model: OrchestrationModelPort
  runtimeObserver?: OrchestrationRuntimeObserverPort
  contextWindow: number
  sessionId: string
  run: ReturnType<OrchestrationSessionPort["getRun"]>
  transcript: OrchestrationTranscriptMessage[]
  signal: AbortSignal
  now: () => number
  tokensBefore: number
  trigger: CompactionMode
}) {
  const summarizeRunId = `run_${crypto.randomUUID()}`
  const summarizeStartedAt = input.now()
  recordObservedRuntimeEvent({
    runtimeObserver: input.runtimeObserver,
    sessionId: input.sessionId,
    runId: summarizeRunId,
    occurredAt: summarizeStartedAt,
    event: {
      type: "run.started",
      runId: summarizeRunId,
    },
  })

  try {
    const summary = await summarizeTranscript({
      model: input.model,
      contextWindow: input.contextWindow,
      sessionId: input.sessionId,
      summarizeRunId,
      transcript: input.transcript,
      signal: input.signal,
    })
    const summarizeFinishedAt = input.now()
    input.session.createRun({
      id: summarizeRunId,
      sessionId: input.sessionId,
      trigger: "summarize",
      status: "completed",
      createdAt: buildSummarizeRunCreatedAt(input.run.createdAt),
      startedAt: summarizeStartedAt,
      finishedAt: summarizeFinishedAt,
      activeSkills: input.run.activeSkills,
      inputTokens: summary.usage.inputTokens,
      outputTokens: summary.usage.outputTokens,
      tokenUsageSource: summary.usage.tokenUsageSource,
    })
    recordObservedRuntimeEvent({
      runtimeObserver: input.runtimeObserver,
      sessionId: input.sessionId,
      runId: summarizeRunId,
      occurredAt: summarizeFinishedAt,
      event: {
        type: "run.completed",
        runId: summarizeRunId,
      },
    })

    const syntheticMessage = appendSyntheticMessageParts({
      session: input.session,
      sessionId: input.sessionId,
      runId: input.run.id,
      now: input.now,
      parts: [
        {
          kind: "compaction_boundary",
          data: {
            tokensBefore: input.tokensBefore,
            tokensAfter: 0,
            compressionRatio: 0,
            summarizeRunId,
            trigger: input.trigger,
          },
        },
        {
          kind: "text",
          text: summary.text,
        },
      ],
    })

    return {
      boundaryPartId: syntheticMessage.parts[0]!.id,
      summarizeRunId,
      tokensBefore: input.tokensBefore,
    }
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      throw error
    }

    if (isDetachedError(error)) {
      throw error
    }

    const errorText = getErrorMessage(error)
    const summarizeFinishedAt = input.now()
    input.session.createRun({
      id: summarizeRunId,
      sessionId: input.sessionId,
      trigger: "summarize",
      status: "failed",
      createdAt: buildSummarizeRunCreatedAt(input.run.createdAt),
      startedAt: summarizeStartedAt,
      finishedAt: summarizeFinishedAt,
      errorText,
      activeSkills: input.run.activeSkills,
    })
    recordObservedRuntimeEvent({
      runtimeObserver: input.runtimeObserver,
      sessionId: input.sessionId,
      runId: summarizeRunId,
      occurredAt: summarizeFinishedAt,
      event: {
        type: "run.failed",
        runId: summarizeRunId,
        error: errorText,
      },
    })

    throw new CompactionRunError({
      message: errorText,
      summarizeRunId,
    })
  }
}

function appendCompactionFailureArtifacts(input: {
  session: OrchestrationSessionPort
  sessionId: string
  runId: string
  trigger: CompactionMode
  error: string
  attemptCount: number
  summarizeRunId: string | null
  emit: OrchestrationEventEmitter
  now: () => number
}) {
  const label =
    input.trigger === "auto" ? "Automatic compaction failed" : "Manual compaction failed"
  appendSyntheticMessageParts({
    session: input.session,
    sessionId: input.sessionId,
    runId: input.runId,
    now: input.now,
    parts: [
      {
        kind: "error",
        text: `${label}: ${input.error}`,
        data: {
          source: "compaction",
          eventType: "compaction.failed",
          trigger: input.trigger,
          error: input.error,
          attemptCount: input.attemptCount,
          summarizeRunId: input.summarizeRunId,
        },
      },
    ],
  })
  input.emit({
    type: "compaction.failed",
    trigger: input.trigger,
    error: input.error,
    attemptCount: input.attemptCount,
    summarizeRunId: input.summarizeRunId,
  })
}

function readCompactionSummarizeRunId(error: unknown) {
  return error instanceof CompactionRunError ? error.summarizeRunId : null
}

async function summarizeTranscript(input: {
  model: OrchestrationModelPort
  contextWindow: number
  sessionId: string
  summarizeRunId: string
  transcript: OrchestrationTranscriptMessage[]
  signal: AbortSignal
}) {
  let summaryText = ""
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    tokenUsageSource: null as "provider" | "estimated" | null,
  }

  const summaryTranscript = [
    ...input.transcript,
    {
      runId: input.summarizeRunId,
      role: "user" as const,
      sequence: Number.MAX_SAFE_INTEGER,
      parts: [
        {
          kind: "text",
          text: COMPACTION_SUMMARY_PROMPT,
        },
      ],
    },
  ]

  for await (const event of input.model.streamTurn({
    systemPrompt:
      "You compress conversation state into a compact continuation summary for the next model turn. Keep it self-contained and concrete.",
    skillCatalog: [],
    activeSkills: [],
    systemReminders: [],
    contextWindow: input.contextWindow,
    tools: [],
    transcript: summaryTranscript,
    sessionId: input.sessionId,
    runId: input.summarizeRunId,
    turnKey: `${input.summarizeRunId}:turn_0`,
    signal: input.signal,
  })) {
    if (event.type === "text.delta") {
      summaryText += event.text
      continue
    }

    if (event.type === "usage") {
      usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        tokenUsageSource: event.source,
      }
      continue
    }

    throw new Error(`Summarize run requested unexpected tool ${event.name}`)
  }

  const sanitizedText = stripAnalysisBlocks(summaryText).trim()
  if (sanitizedText.length === 0) {
    throw new Error("Summarize run produced an empty summary")
  }

  return {
    text: sanitizedText,
    usage,
  }
}

function shouldAutoCompact(inputTokens: number, contextWindow: number) {
  if (contextWindow <= AUTO_COMPACTION_TOKEN_BUFFER) {
    return false
  }

  return inputTokens > contextWindow - AUTO_COMPACTION_TOKEN_BUFFER
}

function buildSummarizeRunCreatedAt(parentRunCreatedAt: number) {
  return Math.max(0, parentRunCreatedAt - SUMMARIZE_RUN_CREATED_AT_OFFSET)
}

function calculateCompressionRatio(tokensBefore: number, tokensAfter: number) {
  if (tokensBefore <= 0) {
    return 0
  }

  return Math.max(0, Number(((tokensBefore - tokensAfter) / tokensBefore).toFixed(4)))
}

function stripAnalysisBlocks(text: string) {
  return text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
}

function appendSyntheticMessageParts(input: {
  session: OrchestrationSessionPort
  sessionId: string
  runId: string
  now: () => number
  parts: Array<{
    kind: string
    text?: string | null
    data?: unknown
  }>
}) {
  const sequence = getNextMessageSequence(input.session.listTranscript(input.sessionId), input.runId)
  const message = input.session.createSyntheticMessage({
    sessionId: input.sessionId,
    runId: input.runId,
    sequence,
    createdAt: input.now(),
  })
  const createdParts = input.parts.map((part, index) =>
    input.session.createMessagePart({
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: message.id,
      kind: part.kind,
      sequence: index,
      text: part.text,
      data: part.data,
      createdAt: input.now(),
    }),
  )

  return {
    message,
    parts: createdParts,
  }
}

function readAutoCompactionState(transcript: OrchestrationTranscriptMessage[]) {
  let consecutiveFailures = 0
  let lastError: string | null = null

  for (let messageIndex = transcript.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = transcript[messageIndex]
    if (!message) {
      continue
    }

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]
      if (!part) {
        continue
      }

      if (part.kind === "compaction_boundary") {
        return {
          open: false,
          consecutiveFailures: 0,
          lastError: null,
        }
      }

      if (part.kind !== "error") {
        continue
      }

      const data = readObject(part.data)
      if (readString(data, "source") !== "compaction") {
        continue
      }

      const eventType = readString(data, "eventType")
      if (eventType === "compaction.circuit_breaker.triggered") {
        return {
          open: true,
          consecutiveFailures: Math.max(
            consecutiveFailures,
            readNumber(data, "consecutiveFailures") ?? AUTO_COMPACTION_FAILURE_LIMIT,
          ),
          lastError: readString(data, "lastError") ?? part.text ?? lastError,
        }
      }

      if (
        eventType === "compaction.failed" &&
        readString(data, "trigger") === "auto"
      ) {
        consecutiveFailures += 1
        lastError = readString(data, "error") ?? part.text ?? lastError
        if (consecutiveFailures >= AUTO_COMPACTION_FAILURE_LIMIT) {
          return {
            open: true,
            consecutiveFailures,
            lastError,
          }
        }
      }
    }
  }

  return {
    open: false,
    consecutiveFailures,
    lastError,
  }
}

function recordObservedRuntimeEvent(input: {
  runtimeObserver?: OrchestrationRuntimeObserverPort
  sessionId: string
  runId: string
  event: RuntimeEvent
  occurredAt: number
}) {
  input.runtimeObserver?.recordRuntimeEvent?.({
    sessionId: input.sessionId,
    runId: input.runId,
    event: input.event,
    occurredAt: input.occurredAt,
  })
}

function readObject(value: unknown) {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function readString(value: Record<string, unknown> | null, key: string) {
  return typeof value?.[key] === "string" ? (value[key] as string) : null
}

function readNumber(value: Record<string, unknown> | null, key: string) {
  return typeof value?.[key] === "number" ? (value[key] as number) : null
}
