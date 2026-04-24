import type {
  OrchestrationSessionPort,
  OrchestrationPartRecord,
  OrchestrationTranscriptMessage,
} from "./ports/session"
import type { OrchestrationModelPort } from "./ports/model"
import type { OrchestrationAgentProfilePort } from "./ports/agent-profile"
import type { OrchestrationContextWindowPort } from "./ports/context-window"
import type { OrchestrationSkillPort } from "./ports/skill"
import {
  type OrchestrationBatchExecutionResult,
  TOOL_FAILURE_MESSAGE_METADATA_KEY,
  TOOL_PERMISSION_DENIED_METADATA_KEY,
  type OrchestrationToolPort,
} from "./ports/tool"
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
import { buildLateContextMessage } from "./prompt-composer"
import { createOrchestrationCompactionService } from "./compaction-service"

type OrchestrationEventEmitter = (event: RuntimeEvent) => void

type CreateOrchestrationStepServiceInput = {
  session: OrchestrationSessionPort
  model: OrchestrationModelPort
  agentProfiles?: OrchestrationAgentProfilePort
  contextWindow: OrchestrationContextWindowPort
  skill: OrchestrationSkillPort
  runtimeObserver?: OrchestrationRuntimeObserverPort
  thinking?: {
    enabled: boolean
    effort?: "default" | "low" | "medium" | "high"
  }
  resolveThinking?: (
    sessionId: string,
  ) =>
    | {
        enabled: boolean
        effort?: "default" | "low" | "medium" | "high"
      }
    | undefined
  telemetry?: {
    capabilityResolution?: {
      model: string
      provider: "openai" | "openai-compatible"
      providerFamily: "kimi" | "generic"
      catalogSource: "models.dev" | "default"
      catalogMiss: boolean
      reasoningSource: "config" | "models.dev" | "default"
      toolCallSource: "config" | "models.dev" | "default"
      interleavedSource: "config" | "models.dev" | "default"
      interleavedField: "reasoning_content" | "reasoning_details" | null
      reasoningEffortSource: "config" | "models.dev" | "default"
      thinkingSource: "config" | "models.dev" | "default"
      thinkingEffortSource: "config" | "models.dev" | "default"
    }
    contextWindow?: {
      contextWindow: number
      source: "config" | "/models" | "models.dev" | "default"
    }
    modelClassification?: {
      model: string
      providerFamily: "kimi" | "generic"
    }
  }
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

type PendingToolCall = ToolCallEvent & {
  args: unknown
}

type AgentLateContext = {
  instructions?: string
  recommendedSkills?: string[]
  temperature?: number
}

const MODEL_REQUEST_MAX_ATTEMPTS = 3

function buildTurnLateContextMessage(input: {
  workspaceRoot: string
  activeSkillNames: readonly string[]
  agentInstructions?: string
  recommendedSkills?: string[]
  systemReminders: readonly string[]
  now: () => number
}) {
  return buildLateContextMessage({
    activeSkillNames: input.activeSkillNames,
    agentInstructions: input.agentInstructions,
    environment: {
      workingDirectory: input.workspaceRoot,
      platform: process.platform,
      shell: process.env.SHELL,
      date: new Date(input.now()).toISOString().slice(0, 10),
    },
    recommendedSkills: input.recommendedSkills,
    systemReminders: input.systemReminders,
  })
}

function deriveCompressibleToolNames(
  tools: ReturnType<OrchestrationToolPort["list"]>,
) {
  if (!tools.some((tool) => tool.isCompressible !== undefined)) {
    return undefined
  }

  return new Set(tools.filter((tool) => tool.isCompressible).map((tool) => tool.name))
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

function isTerminalRunStatus(status: string) {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function resolveCurrentAgentName(input: {
  session: OrchestrationSessionPort
  sessionId: string
}) {
  return input.session.getSession(input.sessionId).currentAgent?.trim() || undefined
}

async function resolveAgentLateContext(input: {
  session: OrchestrationSessionPort
  agentProfiles?: OrchestrationAgentProfilePort
  sessionId: string
  workspaceRoot: string
}): Promise<AgentLateContext | undefined> {
  const currentAgent = resolveCurrentAgentName({
    session: input.session,
    sessionId: input.sessionId,
  })
  if (!currentAgent || !input.agentProfiles) {
    return undefined
  }

  const profile = await input.agentProfiles.getResolvedProfile({
    workspaceRoot: input.workspaceRoot,
    name: currentAgent,
  })
  const instructions = profile?.instructions?.trim()
  const recommendedSkills =
    readAgentProfileSkills(profile)
      ?.map((skill) => skill.trim())
      .filter((skill) => skill.length > 0)
    ?? []

  return {
    instructions: instructions && instructions.length > 0 ? instructions : undefined,
    recommendedSkills: recommendedSkills.length > 0 ? recommendedSkills : undefined,
    temperature: typeof profile?.temperature === "number" ? profile.temperature : undefined,
  }
}

function readAgentProfileSkills(profile: Awaited<ReturnType<OrchestrationAgentProfilePort["getResolvedProfile"]>>) {
  if (!profile || !("skills" in profile)) {
    return undefined
  }

  return Array.isArray(profile.skills)
    ? profile.skills.filter((skill): skill is string => typeof skill === "string")
    : undefined
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

function shouldRetryModelRequest(input: { attempt: number; error: unknown }) {
  return input.attempt < MODEL_REQUEST_MAX_ATTEMPTS
    && !!(
      input.error && typeof input.error === "object"
      && (input.error as { classified?: { retryable?: unknown } }).classified?.retryable === true
    )
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
      let loadedSkill
      try {
        loadedSkill = await input.skill.loadSkill({
          workspaceRoot: inputValue.workspaceRoot,
          name: skillName,
        })
      } catch (error) {
        inputValue.emit({
          type: "skill.load.failed",
          status: "failed",
          skillName,
          reason: inputValue.reason,
          error: getErrorMessage(error),
        })
        throw error
      }
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

  const compactionService = createOrchestrationCompactionService({
    session: input.session,
    model: input.model,
    runtimeObserver: input.runtimeObserver,
    skillReminders,
    recentFiles,
    buildLateContextMessage(inputValue) {
      return buildTurnLateContextMessage({
        ...inputValue,
        now,
      })
    },
    async recoverActiveSkills(inputValue) {
      await loadPendingActiveSkills({
        ...inputValue,
        emit: inputValue.emit,
        reason: "recovery",
      })
    },
    now,
  })

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
      if (input.telemetry?.capabilityResolution) {
        runInput.emit({
          type: "capability.resolution.recorded",
          ...input.telemetry.capabilityResolution,
        })
      }
      if (input.telemetry?.contextWindow) {
        runInput.emit({
          type: "context.window.resolved",
          ...input.telemetry.contextWindow,
        })
      }
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
      if (input.telemetry?.modelClassification?.providerFamily === "kimi") {
        runInput.emit({
          type: "kimi.run.classified",
          model: input.telemetry.modelClassification.model,
          outcome: "success",
        })
      }
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
      if (input.telemetry?.modelClassification?.providerFamily === "kimi") {
        runInput.emit({
          type: "kimi.run.classified",
          model: input.telemetry.modelClassification.model,
          outcome: "failure",
        })
      }
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
      const compressibleToolNames = deriveCompressibleToolNames(availableTools)
      const exposedCatalogSkillNames = skillReminders.exposeCatalog(stepInput.sessionId, skillCatalog)
      if (exposedCatalogSkillNames.length > 0) {
        stepInput.emit({
          type: "skill.catalog.exposed",
          catalogSkillNames: exposedCatalogSkillNames,
          catalogSkillCount: exposedCatalogSkillNames.length,
        })
      }
      const sessionRecord = input.session.getSession(stepInput.sessionId)
      const sessionActiveSkills = sessionRecord.activeSkills
      await loadPendingActiveSkills({
        sessionId: stepInput.sessionId,
        activeSkillNames: sessionActiveSkills,
        workspaceRoot: stepInput.workspaceRoot,
        emit: stepInput.emit,
        reason: "prompt",
      })

      const pendingReminderBatch = skillReminders.peekSystemReminderBatch(stepInput.sessionId)
      const autoCompaction = compactionService.shouldDeferAutoCompactionUntilAfterManualRecovery({
        transcript,
        reminderBatch: pendingReminderBatch,
      })
        ? { compacted: false as const }
        : await compactionService.maybeAutoCompact({
            contextWindow,
            sessionId: stepInput.sessionId,
            runId: stepInput.runId,
            systemPrompt: stepInput.systemPrompt,
            workspaceRoot: stepInput.workspaceRoot,
            skillCatalog,
            tools: availableTools,
            compressibleToolNames,
            signal: stepInput.signal,
            emit: stepInput.emit,
            run,
            transcript,
          })
      if (autoCompaction.compacted) {
        transcript = input.session.listTranscript(stepInput.sessionId)
      }
      transcript = input.session.listTranscript(stepInput.sessionId)
      const activeSkills = skillReminders.resolveActiveSkills(stepInput.sessionId, sessionActiveSkills)
      const systemReminderBatch = skillReminders.consumeSystemReminderBatch(stepInput.sessionId)
      const systemReminders = systemReminderBatch?.messages ?? []
      const currentAgentName = resolveCurrentAgentName({
        session: input.session,
        sessionId: stepInput.sessionId,
      })
      const agentLateContext: AgentLateContext | undefined = await resolveAgentLateContext({
        session: input.session,
        agentProfiles: input.agentProfiles,
        sessionId: stepInput.sessionId,
        workspaceRoot: stepInput.workspaceRoot,
      })
      const lateContextMessage = buildTurnLateContextMessage({
        workspaceRoot: stepInput.workspaceRoot,
        activeSkillNames: activeSkills.map((skill) => skill.name),
        agentInstructions: agentLateContext?.instructions,
        recommendedSkills: agentLateContext?.recommendedSkills,
        systemReminders,
        now,
      })
      const turnKey = createTurnKey(stepInput.runId, getNextMessageSequence(transcript, stepInput.runId))
      const effectiveThinking = input.resolveThinking?.(stepInput.sessionId) ?? input.thinking
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
        let iterator: AsyncIterator<
          Awaited<ReturnType<OrchestrationModelPort["streamTurn"]>> extends AsyncIterable<infer T>
            ? T
            : never
        > | null = null

        try {
          const pendingToolCalls: ToolCallEvent[] = []
          const modelEvents = input.model.streamTurn({
            systemPrompt: stepInput.systemPrompt,
            lateContextMessage,
            skillCatalog,
            activeSkills,
            systemReminders,
            systemReminderMetadata: systemReminderBatch && {
              catalogSkillNames: systemReminderBatch.catalogSkillNames,
              activeSkillNames: systemReminderBatch.activeSkillNames,
              recoveryFilePaths: systemReminderBatch.recoveryFilePaths,
            },
            contextWindow,
            thinking: effectiveThinking,
            temperature: agentLateContext?.temperature,
            tools: availableTools,
            transcript,
            compressibleToolNames,
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

            const item = next.value
            if (item.type === "text.delta") {
              assistantTurn.appendText(item.text)
              stepInput.emit({ type: "message.delta", text: item.text })
              if (stepInput.signal.aborted) {
                throw createAbortError()
              }
              continue
            }

            if (item.type === "reasoning.delta") {
              assistantTurn.appendReasoning(item.text)
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
            assistantTurn.appendToolCall({
              callId: item.callId,
              toolName: item.name,
              inputText: item.inputText,
            })
            pendingToolCalls.push(item)
          }

          const outcome = await executePendingToolCalls({
            items: pendingToolCalls,
            assistantTurn,
            emit: stepInput.emit,
            sessionId: stepInput.sessionId,
            signal: stepInput.signal,
            recentFiles,
            tools: stepInput.tools,
            workspaceRoot: stepInput.workspaceRoot,
            currentAgentName,
            agentProfiles: input.agentProfiles,
          })

          if (outcome === "cancel") {
            return {
              status: "cancelled" as const,
            }
          }

          break
        } catch (error) {
          if (isAbortError(error, stepInput.signal)) {
            throw error
          }

          void iterator?.return?.()

          if (shouldRetryModelRequest({ attempt, error })) {
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
      const skillCatalog = await input.skill.listCatalog(compactionInput.workspaceRoot)
      const availableTools = compactionInput.tools.list()
      const compressibleToolNames = deriveCompressibleToolNames(availableTools)

      return compactionService.compactSession({
        contextWindow,
        sessionId: compactionInput.sessionId,
        runId: compactionInput.runId,
        systemPrompt: compactionInput.systemPrompt,
        workspaceRoot: compactionInput.workspaceRoot,
        skillCatalog,
        tools: availableTools,
        compressibleToolNames,
        signal: compactionInput.signal,
        emit: compactionInput.emit,
      })
    },
  }
}

function createTurnKey(runId: string, messageSequence: number) {
  return `${runId}:turn_${messageSequence}`
}

async function executePendingToolCalls(input: {
  items: ToolCallEvent[]
  assistantTurn: ReturnType<typeof createAssistantTurnRecorder>
  emit: OrchestrationEventEmitter
  sessionId: string
  signal: AbortSignal
  recentFiles: ReturnType<typeof createRecentFileTracker>
  tools: OrchestrationToolPort
  workspaceRoot: string
  currentAgentName?: string
  agentProfiles?: OrchestrationAgentProfilePort
}): Promise<ToolCallOutcome> {
  const pendingToolCalls = collectPendingToolCalls({
    items: input.items,
    assistantTurn: input.assistantTurn,
  })
  if (pendingToolCalls.length === 0) {
    return "continue"
  }

  const { executableCalls, deniedResultsByIndex } = await partitionToolCallsForCurrentAgent({
    pendingToolCalls,
    currentAgentName: input.currentAgentName,
    agentProfiles: input.agentProfiles,
    workspaceRoot: input.workspaceRoot,
  })
  const executedResults = executableCalls.length === 0
    ? []
    : await input.tools.executeBatch({
        calls: executableCalls.map((item) => ({
          callId: item.callId,
          toolName: item.name,
          args: item.args,
          onProgress: (message: string) => {
            input.emit({
              type: "tool.progress",
              toolCallId: item.callId,
              message,
              timestamp: Date.now(),
            })
          },
        })),
        workspaceRoot: input.workspaceRoot,
        signal: input.signal,
      })
  const results = mergeToolExecutionResults({
    pendingToolCalls,
    executableCalls,
    deniedResultsByIndex,
    executedResults,
  })
  let shouldCancel = false

  for (const result of results) {
    if (input.signal.aborted) {
      throw createAbortError()
    }

    const toolFailureMessage = readMetadataString(
      result.metadata,
      TOOL_FAILURE_MESSAGE_METADATA_KEY,
    )
    if (toolFailureMessage) {
      input.assistantTurn.appendError({
        text: toolFailureMessage,
        data: {
          source: "tool",
          callId: result.callId,
          toolName: result.toolName,
        },
      })

      if (readMetadataBoolean(result.metadata, TOOL_PERMISSION_DENIED_METADATA_KEY)) {
        shouldCancel = true
      }

      continue
    }

    input.assistantTurn.appendToolResult({
      callId: result.callId,
      toolName: result.toolName,
      output: result.output,
      isError: result.isError,
      metadata: result.metadata,
    })
    input.emit({
      type: "tool.call.completed",
      callId: result.callId,
      name: result.toolName,
      output: result.output,
    })

    if (result.toolName === "read") {
      const pendingToolCall = pendingToolCalls.find((item) => item.callId === result.callId)
      const readArgs = readObject(pendingToolCall?.args)
      const path = readString(readArgs, "path")
      if (path) {
        input.recentFiles.recordRead({
          sessionId: input.sessionId,
          path,
          content: result.output,
        })
      }
    }
  }

  return shouldCancel ? "cancel" : "continue"
}

function collectPendingToolCalls(input: {
  items: ToolCallEvent[]
  assistantTurn: ReturnType<typeof createAssistantTurnRecorder>
}) {
  const pendingToolCalls: PendingToolCall[] = []

  for (const item of input.items) {
    let args: unknown
    try {
      args = JSON.parse(item.inputText)
    } catch (error) {
      input.assistantTurn.appendError({
        text: `Malformed tool arguments for ${item.name}: ${getErrorMessage(error)}`,
        data: {
          source: "tool",
          callId: item.callId,
          toolName: item.name,
        },
      })
      continue
    }

    pendingToolCalls.push({
      ...item,
      args,
    })
  }

  return pendingToolCalls
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
  let activeReasoningPart: { id: string; text: string } | null = null

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
    activeReasoningPart = part.kind === "reasoning" ? readActiveReasoningPart(createdPart) : null
    return createdPart
  }

  return {
    appendReasoning(text: string) {
      if (activeReasoningPart) {
        activeReasoningPart.text += text
        input.session.updateMessagePart({
          partId: activeReasoningPart.id,
          text: activeReasoningPart.text,
        })
        return
      }

      createPart({
        kind: "reasoning",
        text,
      })
    },
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

function readActiveReasoningPart(part: OrchestrationPartRecord) {
  if (part.kind !== "reasoning") {
    return null
  }

  return {
    id: part.id,
    text: part.text ?? "",
  }
}

function readObject(value: unknown) {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function readString(value: Record<string, unknown> | null, key: string) {
  return typeof value?.[key] === "string" ? (value[key] as string) : null
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string) {
  return typeof metadata?.[key] === "string" ? metadata[key] : null
}

function readMetadataBoolean(metadata: Record<string, unknown> | undefined, key: string) {
  return metadata?.[key] === true
}

async function partitionToolCallsForCurrentAgent(input: {
  pendingToolCalls: PendingToolCall[]
  currentAgentName?: string
  agentProfiles?: OrchestrationAgentProfilePort
  workspaceRoot: string
}) {
  const executableCalls: PendingToolCall[] = []
  const deniedResultsByIndex = new Map<number, OrchestrationBatchExecutionResult>()

  for (const [index, toolCall] of input.pendingToolCalls.entries()) {
    if (!input.currentAgentName || !input.agentProfiles?.checkToolAccess) {
      executableCalls.push(toolCall)
      continue
    }

    const access = await input.agentProfiles.checkToolAccess({
      workspaceRoot: input.workspaceRoot,
      agentName: input.currentAgentName,
      toolName: toolCall.name,
    })
    if (access.allowed) {
      executableCalls.push(toolCall)
      continue
    }

    deniedResultsByIndex.set(index, {
      callId: toolCall.callId,
      toolName: toolCall.name,
      output: access.deniedMessage
        ?? `Tool '${toolCall.name}' is not available for the current agent.`,
      isError: true,
    })
  }

  return {
    executableCalls,
    deniedResultsByIndex,
  }
}

function mergeToolExecutionResults(input: {
  pendingToolCalls: PendingToolCall[]
  executableCalls: PendingToolCall[]
  deniedResultsByIndex: Map<number, OrchestrationBatchExecutionResult>
  executedResults: OrchestrationBatchExecutionResult[]
}) {
  const orderedResults = new Array<OrchestrationBatchExecutionResult>(input.pendingToolCalls.length)

  input.deniedResultsByIndex.forEach((result, index) => {
    orderedResults[index] = result
  })

  input.executableCalls.forEach((toolCall, index) => {
    const executionResult = input.executedResults[index]
    if (!executionResult) {
      throw new Error(`Missing tool result for call '${toolCall.callId}'`)
    }

    const originalIndex = input.pendingToolCalls.findIndex((pendingToolCall) => pendingToolCall.callId === toolCall.callId)
    if (originalIndex < 0) {
      throw new Error(`Missing pending tool call for '${toolCall.callId}'`)
    }

    orderedResults[originalIndex] = executionResult
  })

  return orderedResults.map((result, index) => {
    if (!result) {
      throw new Error(`Missing tool result for call index ${index}`)
    }

    return result
  })
}
