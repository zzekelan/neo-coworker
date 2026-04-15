import { countTokens } from "gpt-tokenizer/model/gpt-4o"
import { buildContextUsageSnapshot } from "./context-usage"
import type { RuntimeEvent } from "./event"
import type { OrchestrationModelPort } from "./ports/model"
import type {
  OrchestrationRuntimeObserverPort,
  RuntimeObserverEvent,
} from "./ports/runtime-observer"
import type {
  OrchestrationRunRecord,
  OrchestrationSessionPort,
  OrchestrationTranscriptMessage,
  OrchestrationTranscriptPart,
} from "./ports/session"
import type { OrchestrationSkillPort } from "./ports/skill"
import type { OrchestrationToolPort } from "./ports/tool"
import { createRecentFileTracker } from "./recent-file-tracker"
import {
  createSkillReminderTracker,
  type SkillReminderBatch,
} from "./skill-reminder-tracker"

export const AUTO_COMPACTION_TOKEN_BUFFER = 12_500
const AUTO_COMPACTION_FAILURE_LIMIT = 3
const SUMMARIZE_RUN_CREATED_AT_OFFSET = 1
const COMPACTION_TAIL_TOKEN_BUDGET_RATIO = 0.2
const MIN_COMPACTION_TAIL_TOKENS = 128
const MAX_COMPACTION_TAIL_TOKENS = 6_000
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

export const COMPACTION_HANDOFF_FRAMING =
  "You are continuing a conversation. A previous assistant handled the first part. Here is a summary of what was accomplished and what remains:"
export const COMPACTION_TAIL_HEADING = "Recent conversation tail preserved verbatim:"

const COMPACTION_SUMMARY_PROMPT = [
  "Summarize the conversation so the next model turn can continue the same work after context compaction.",
  "Return plain text with exactly these nine section headings, in this order:",
  ...SUMMARY_SECTION_TITLES.map((title) => `- ${title}`),
  "Preserve concrete user intent, decisions, file paths, code changes, failures, pending work, and the current next action.",
  "Do not include an <analysis> block in the final answer.",
].join("\n")

const ITERATIVE_COMPACTION_SUMMARY_PROMPT_PREFIX = [
  "Update the existing compaction summary with the new conversation turns in this transcript.",
  "Preserve still-relevant details from the previous summary, add new progress, and remove information only when it is clearly obsolete.",
  "Move completed work out of pending sections when appropriate.",
].join("\n")

type OrchestrationEventEmitter = (event: RuntimeEvent) => void
type SkillReminderTracker = ReturnType<typeof createSkillReminderTracker>
type RecentFileTracker = ReturnType<typeof createRecentFileTracker>
type CompactionMode = "auto" | "manual"

type ExecuteCompactionInput = {
  contextWindow: number
  sessionId: string
  runId: string
  systemPrompt: string
  workspaceRoot: string
  skillCatalog: Awaited<ReturnType<OrchestrationSkillPort["listCatalog"]>>
  tools: ReturnType<OrchestrationToolPort["list"]>
  compressibleToolNames?: ReadonlySet<string>
  signal: AbortSignal
  emit: OrchestrationEventEmitter
}

type AutoCompactionInput = ExecuteCompactionInput & {
  run: OrchestrationRunRecord
  transcript: OrchestrationTranscriptMessage[]
}

type CompactionRunInput = ExecuteCompactionInput & {
  run: OrchestrationRunRecord
  transcript: OrchestrationTranscriptMessage[]
  trigger: CompactionMode
  tokensBefore: number
}

type CompactionRunResult = {
  boundaryPartId: string
  summarizeRunId: string
  tokensBefore: number
}

type CompactionPromptPlan = {
  sourceMessages: OrchestrationTranscriptMessage[]
  messagesToSummarize: OrchestrationTranscriptMessage[]
  protectedTailMessages: OrchestrationTranscriptMessage[]
  previousSummary: string | null
}

type CompactionProjectionContext = {
  activeSkills: ReturnType<SkillReminderTracker["resolveActiveSkills"]>
  systemReminders: string[]
  lateContextMessage: string
}

type CompactionProjectionInput = {
  model: OrchestrationModelPort
  systemPrompt: string
  skillCatalog: Awaited<ReturnType<OrchestrationSkillPort["listCatalog"]>>
  activeSkillNames: readonly string[]
  contextWindow: number
  tools: ReturnType<OrchestrationToolPort["list"]>
  transcript: OrchestrationTranscriptMessage[]
  compressibleToolNames?: ReadonlySet<string>
  sessionId: string
  runId: string
  workspaceRoot: string
}

export type ManualCompactionResult =
  | {
      status: "completed" | "cancelled"
    }
  | {
      status: "failed"
      error: string
    }

export function createOrchestrationCompactionService(input: {
  session: OrchestrationSessionPort
  model: OrchestrationModelPort
  runtimeObserver?: OrchestrationRuntimeObserverPort
  skillReminders: SkillReminderTracker
  recentFiles: RecentFileTracker
  buildLateContextMessage(input: {
    workspaceRoot: string
    activeSkillNames: readonly string[]
    systemReminders: readonly string[]
  }): string
  recoverActiveSkills(inputValue: {
    sessionId: string
    activeSkillNames: readonly string[]
    workspaceRoot: string
    emit: OrchestrationEventEmitter
  }): Promise<void>
  now?: () => number
}) {
  const now = input.now ?? Date.now

  async function recoverCompactedContext(inputValue: {
    sessionId: string
    workspaceRoot: string
    emit: OrchestrationEventEmitter
  }) {
    const session = input.session.getSession(inputValue.sessionId)
    await input.recoverActiveSkills({
      sessionId: inputValue.sessionId,
      activeSkillNames: session.activeSkills,
      workspaceRoot: inputValue.workspaceRoot,
      emit: inputValue.emit,
    })

    const recentFileReminder = input.recentFiles.buildRecoveryReminder(inputValue.sessionId)
    if (recentFileReminder) {
      input.skillReminders.appendRecoveryReminder({
        sessionId: inputValue.sessionId,
        text: recentFileReminder.text,
        filePaths: recentFileReminder.filePaths,
      })
    }
  }

  return {
    shouldDeferAutoCompactionUntilAfterManualRecovery(inputValue: {
      transcript: OrchestrationTranscriptMessage[]
      reminderBatch: SkillReminderBatch | undefined
    }) {
      return (
        readLatestCompactionBoundaryTrigger(inputValue.transcript) === "manual" &&
        hasPendingRecoveryContext(inputValue.reminderBatch)
      )
    },
    async maybeAutoCompact(inputValue: AutoCompactionInput) {
      if (!input.model.projectTurn) {
        return { compacted: false as const }
      }

      const projected = projectCompactionInputTokens({
        model: input.model,
        systemPrompt: inputValue.systemPrompt,
        contextWindow: inputValue.contextWindow,
        sessionId: inputValue.sessionId,
        runId: inputValue.run.id,
        workspaceRoot: inputValue.workspaceRoot,
        skillCatalog: inputValue.skillCatalog,
        activeSkillNames: inputValue.run.activeSkills,
        tools: inputValue.tools,
        transcript: inputValue.transcript,
        compressibleToolNames: inputValue.compressibleToolNames,
        skillReminders: input.skillReminders,
        buildLateContextMessage: input.buildLateContextMessage,
      })

      if (!shouldAutoCompact(projected.inputTokens, inputValue.contextWindow)) {
        return { compacted: false as const }
      }

      const breakerState = readAutoCompactionState(inputValue.transcript)
      if (breakerState.open) {
        return { compacted: false as const }
      }

      try {
        await completeCompaction({
          session: input.session,
          model: input.model,
          runtimeObserver: input.runtimeObserver,
          skillReminders: input.skillReminders,
          recoverCompactedContext,
          buildLateContextMessage: input.buildLateContextMessage,
          now,
          ...inputValue,
          trigger: "auto",
          tokensBefore: projected.inputTokens,
        })
        return { compacted: true as const }
      } catch (error) {
        if (isAbortError(error, inputValue.signal)) {
          throw error
        }

        if (isDetachedError(error)) {
          throw error
        }

        const errorText = getErrorMessage(error)
        const attemptCount = breakerState.consecutiveFailures + 1
        appendCompactionFailureArtifacts({
          session: input.session,
          sessionId: inputValue.sessionId,
          runId: inputValue.run.id,
          trigger: "auto",
          error: errorText,
          attemptCount,
          summarizeRunId: readCompactionSummarizeRunId(error),
          emit: inputValue.emit,
          now,
        })

        if (attemptCount >= AUTO_COMPACTION_FAILURE_LIMIT) {
          const breakerText =
            "⚠️ Automatic compaction has been paused. Run /compact successfully to re-enable it."
          appendSyntheticMessageParts({
            session: input.session,
            sessionId: inputValue.sessionId,
            runId: inputValue.run.id,
            now,
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
          inputValue.emit({
            type: "compaction.circuit_breaker.triggered",
            consecutiveFailures: attemptCount,
            lastError: errorText,
            resolution: "manual_compact",
          })
        }

        return { compacted: false as const }
      }
    },
    async compactSession(inputValue: ExecuteCompactionInput): Promise<ManualCompactionResult> {
      const run = input.session.getRun(inputValue.runId)
      const transcript = input.session.listTranscript(inputValue.sessionId)

      if (!input.model.projectTurn) {
        const error = "Manual compaction is unavailable because token projection is not configured."
        appendCompactionFailureArtifacts({
          session: input.session,
          sessionId: inputValue.sessionId,
          runId: inputValue.runId,
          trigger: "manual",
          error,
          attemptCount: 1,
          summarizeRunId: null,
          emit: inputValue.emit,
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
          sessionId: inputValue.sessionId,
          runId: inputValue.runId,
          trigger: "manual",
          error,
          attemptCount: 1,
          summarizeRunId: null,
          emit: inputValue.emit,
          now,
        })
        return {
          status: "failed",
          error,
        }
      }

      const projectedBefore = projectCompactionInputTokens({
        model: input.model,
        systemPrompt: inputValue.systemPrompt,
        contextWindow: inputValue.contextWindow,
        sessionId: inputValue.sessionId,
        runId: inputValue.runId,
        workspaceRoot: inputValue.workspaceRoot,
        skillCatalog: inputValue.skillCatalog,
        activeSkillNames: run.activeSkills,
        tools: inputValue.tools,
        transcript,
        compressibleToolNames: inputValue.compressibleToolNames,
        skillReminders: input.skillReminders,
        buildLateContextMessage: input.buildLateContextMessage,
      })

      try {
        await completeCompaction({
          session: input.session,
          model: input.model,
          runtimeObserver: input.runtimeObserver,
          skillReminders: input.skillReminders,
          recoverCompactedContext,
          buildLateContextMessage: input.buildLateContextMessage,
          now,
          ...inputValue,
          run,
          transcript,
          trigger: "manual",
          tokensBefore: projectedBefore.inputTokens,
        })
        inputValue.emit({
          type: "context.usage.updated",
          sessionId: inputValue.sessionId,
          runId: inputValue.runId,
          ...buildContextUsageSnapshot({
            contextTokens: projectCompactionInputTokens({
              model: input.model,
              systemPrompt: inputValue.systemPrompt,
              contextWindow: inputValue.contextWindow,
              sessionId: inputValue.sessionId,
              runId: inputValue.runId,
              workspaceRoot: inputValue.workspaceRoot,
              skillCatalog: inputValue.skillCatalog,
              activeSkillNames: input.session.getSession(inputValue.sessionId).activeSkills,
              tools: inputValue.tools,
              transcript: input.session.listTranscript(inputValue.sessionId),
              compressibleToolNames: inputValue.compressibleToolNames,
              skillReminders: input.skillReminders,
              buildLateContextMessage: input.buildLateContextMessage,
            }).inputTokens,
            contextWindow: inputValue.contextWindow,
            source: "estimated",
          }),
        })
        return {
          status: "completed",
        }
      } catch (error) {
        if (isAbortError(error, inputValue.signal)) {
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
          sessionId: inputValue.sessionId,
          runId: inputValue.runId,
          trigger: "manual",
          error: message,
          attemptCount: 1,
          summarizeRunId: readCompactionSummarizeRunId(error),
          emit: inputValue.emit,
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

async function completeCompaction(input: CompactionRunInput & {
  session: OrchestrationSessionPort
  model: OrchestrationModelPort
  runtimeObserver?: OrchestrationRuntimeObserverPort
  skillReminders: SkillReminderTracker
  recoverCompactedContext(inputValue: {
    sessionId: string
    workspaceRoot: string
    emit: OrchestrationEventEmitter
  }): Promise<void>
  buildLateContextMessage(input: {
    workspaceRoot: string
    activeSkillNames: readonly string[]
    systemReminders: readonly string[]
  }): string
  now: () => number
}) {
  const result = await performCompactionRun(input)

  input.skillReminders.resetAfterCompaction(input.sessionId)
  await input.recoverCompactedContext({
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    emit: input.emit,
  })

  const projectionAfter = projectCompactionInputTokens({
    model: input.model,
    systemPrompt: input.systemPrompt,
    contextWindow: input.contextWindow,
    sessionId: input.sessionId,
    runId: input.runId,
    workspaceRoot: input.workspaceRoot,
    skillCatalog: input.skillCatalog,
    activeSkillNames: input.session.getSession(input.sessionId).activeSkills,
    tools: input.tools,
    transcript: input.session.listTranscript(input.sessionId),
    compressibleToolNames: input.compressibleToolNames,
    skillReminders: input.skillReminders,
    buildLateContextMessage: input.buildLateContextMessage,
  })
  const compressionRatio = calculateCompressionRatio(result.tokensBefore, projectionAfter.inputTokens)

  input.session.updateMessagePart({
    partId: result.boundaryPartId,
    data: {
      tokensBefore: result.tokensBefore,
      tokensAfter: projectionAfter.inputTokens,
      compressionRatio,
      summarizeRunId: result.summarizeRunId,
      trigger: input.trigger,
    },
  })
  input.emit({
    type: "compaction.completed",
    trigger: input.trigger,
    summarizeRunId: result.summarizeRunId,
    tokensBefore: result.tokensBefore,
    tokensAfter: projectionAfter.inputTokens,
    compressionRatio,
  })
}

async function performCompactionRun(input: CompactionRunInput & {
  session: OrchestrationSessionPort
  model: OrchestrationModelPort
  runtimeObserver?: OrchestrationRuntimeObserverPort
  now: () => number
}) {
  const summarizeRunId = `run_${crypto.randomUUID()}`
  const summarizeStartedAt = input.now()
  const promptPlan = buildCompactionPromptPlan({
    transcript: input.transcript,
    tailTokenBudget: resolveCompactionTailTokenBudget(input.contextWindow),
  })

  recordObservedRuntimeEvent({
    runtimeObserver: input.runtimeObserver,
    sessionId: input.sessionId,
    runId: input.run.id,
    occurredAt: summarizeStartedAt,
    event: {
      type: "compaction.triggered",
      reason: input.trigger,
      messageCount: promptPlan.sourceMessages.length,
      estimatedTokens: input.tokensBefore,
    },
  })
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
      transcript: promptPlan.messagesToSummarize,
      previousSummary: promptPlan.previousSummary,
      compressibleToolNames: input.compressibleToolNames,
      signal: input.signal,
    })
    const finalText = buildCompactionSummaryText({
      summaryText: summary.text,
      protectedTailMessages: promptPlan.protectedTailMessages,
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
    recordObservedRuntimeEvent({
      runtimeObserver: input.runtimeObserver,
      sessionId: input.sessionId,
      runId: input.run.id,
      occurredAt: summarizeFinishedAt,
      event: {
        type: "compaction.summary_generated",
        summaryLength: summary.text.length,
        sectionsIncluded: SUMMARY_SECTION_TITLES.filter((title) =>
          summary.text.includes(title),
        ),
      },
    })

    if (promptPlan.previousSummary) {
      recordObservedRuntimeEvent({
        runtimeObserver: input.runtimeObserver,
        sessionId: input.sessionId,
        runId: input.run.id,
        occurredAt: summarizeFinishedAt,
        event: {
          type: "compaction.iterative_merge",
          previousSummaryLength: promptPlan.previousSummary.length,
          newSummaryLength: summary.text.length,
        },
      })
    }

    recordObservedRuntimeEvent({
      runtimeObserver: input.runtimeObserver,
      sessionId: input.sessionId,
      runId: input.run.id,
      occurredAt: summarizeFinishedAt,
      event: {
        type: "compaction.handoff_framing",
        framingLength: COMPACTION_HANDOFF_FRAMING.length,
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
          text: finalText,
        },
      ],
    })

    return {
      boundaryPartId: syntheticMessage.parts[0]!.id,
      summarizeRunId,
      tokensBefore: input.tokensBefore,
    } satisfies CompactionRunResult
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

class CompactionRunError extends Error {
  readonly summarizeRunId: string

  constructor(input: { message: string; summarizeRunId: string }) {
    super(input.message)
    this.name = "CompactionRunError"
    this.summarizeRunId = input.summarizeRunId
  }
}

function projectCompactionInputTokens(input: CompactionProjectionInput & {
  skillReminders: SkillReminderTracker
  buildLateContextMessage(input: {
    workspaceRoot: string
    activeSkillNames: readonly string[]
    systemReminders: readonly string[]
  }): string
}) {
  const projectionContext = buildCompactionProjectionContext({
    sessionId: input.sessionId,
    activeSkillNames: input.activeSkillNames,
    workspaceRoot: input.workspaceRoot,
    skillReminders: input.skillReminders,
    buildLateContextMessage: input.buildLateContextMessage,
  })

  return (
    input.model.projectTurn?.({
      systemPrompt: input.systemPrompt,
      lateContextMessage: projectionContext.lateContextMessage,
      skillCatalog: input.skillCatalog,
      activeSkills: projectionContext.activeSkills,
      systemReminders: projectionContext.systemReminders,
      contextWindow: input.contextWindow,
      tools: input.tools,
      transcript: input.transcript,
      compressibleToolNames: input.compressibleToolNames,
      sessionId: input.sessionId,
      runId: input.runId,
      turnKey: createTurnKey(input.runId, getNextMessageSequence(input.transcript, input.runId)),
    }) ?? { inputTokens: 0 }
  )
}

function buildCompactionProjectionContext(input: {
  sessionId: string
  activeSkillNames: readonly string[]
  workspaceRoot: string
  skillReminders: SkillReminderTracker
  buildLateContextMessage(input: {
    workspaceRoot: string
    activeSkillNames: readonly string[]
    systemReminders: readonly string[]
  }): string
}): CompactionProjectionContext {
  const activeSkills = input.skillReminders.resolveActiveSkills(
    input.sessionId,
    input.activeSkillNames,
  )
  const systemReminders =
    input.skillReminders.peekSystemReminderBatch(input.sessionId)?.messages ?? []

  return {
    activeSkills,
    systemReminders,
    lateContextMessage: input.buildLateContextMessage({
      workspaceRoot: input.workspaceRoot,
      activeSkillNames: activeSkills.map((skill) => skill.name),
      systemReminders,
    }),
  }
}

async function summarizeTranscript(input: {
  model: OrchestrationModelPort
  contextWindow: number
  sessionId: string
  summarizeRunId: string
  transcript: OrchestrationTranscriptMessage[]
  previousSummary: string | null
  compressibleToolNames?: ReadonlySet<string>
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
          text: buildCompactionPromptText(input.previousSummary),
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
    compressibleToolNames: input.compressibleToolNames,
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

function buildCompactionPromptText(previousSummary: string | null) {
  if (!previousSummary) {
    return COMPACTION_SUMMARY_PROMPT
  }

  return [
    ITERATIVE_COMPACTION_SUMMARY_PROMPT_PREFIX,
    "",
    "Previous compaction summary:",
    previousSummary,
    "",
    COMPACTION_SUMMARY_PROMPT,
  ].join("\n")
}

function buildCompactionPromptPlan(input: {
  transcript: OrchestrationTranscriptMessage[]
  tailTokenBudget: number
}): CompactionPromptPlan {
  const latestBoundaryIndex = findLatestCompactionBoundaryIndex(input.transcript)
  const previousSummary =
    latestBoundaryIndex >= 0
      ? extractPreviousCompactionSummary(input.transcript[latestBoundaryIndex] ?? null)
      : null
  const sourceMessages =
    latestBoundaryIndex >= 0 ? input.transcript.slice(latestBoundaryIndex + 1) : input.transcript
  const tailStartIndex = findTailStartIndexByTokenBudget(sourceMessages, input.tailTokenBudget)

  return {
    sourceMessages,
    messagesToSummarize: sourceMessages.slice(0, tailStartIndex),
    protectedTailMessages: sourceMessages.slice(tailStartIndex),
    previousSummary,
  }
}

export function selectTailMessagesByTokenBudget(input: {
  transcript: OrchestrationTranscriptMessage[]
  tailTokenBudget: number
}) {
  return input.transcript.slice(
    findTailStartIndexByTokenBudget(input.transcript, input.tailTokenBudget),
  )
}

function findTailStartIndexByTokenBudget(
  transcript: OrchestrationTranscriptMessage[],
  tailTokenBudget: number,
) {
  if (transcript.length <= 1) {
    return transcript.length
  }

  let accumulatedTokens = 0
  let tailStartIndex = transcript.length

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const nextTokens = estimateTranscriptMessageTokens(transcript[index])
    if (accumulatedTokens + nextTokens > tailTokenBudget && tailStartIndex < transcript.length) {
      break
    }

    accumulatedTokens += nextTokens
    tailStartIndex = index
  }

  return tailStartIndex === 0 ? 1 : tailStartIndex
}

function estimateTranscriptMessageTokens(message: OrchestrationTranscriptMessage | undefined) {
  if (!message) {
    return 0
  }

  let tokens = 8
  for (const part of message.parts) {
    tokens += estimateTranscriptPartTokens(part)
  }
  return tokens
}

function estimateTranscriptPartTokens(part: OrchestrationTranscriptPart) {
  let tokens = 0
  if (part.text) {
    tokens += countTokens(part.text)
  }

  const data = part.data == null ? null : JSON.stringify(part.data)
  if (data) {
    tokens += countTokens(data)
  }
  return tokens
}

function resolveCompactionTailTokenBudget(contextWindow: number) {
  return Math.max(
    MIN_COMPACTION_TAIL_TOKENS,
    Math.min(MAX_COMPACTION_TAIL_TOKENS, Math.floor(contextWindow * COMPACTION_TAIL_TOKEN_BUDGET_RATIO)),
  )
}

function buildCompactionSummaryText(input: {
  summaryText: string
  protectedTailMessages: OrchestrationTranscriptMessage[]
}) {
  const summaryBody = [COMPACTION_HANDOFF_FRAMING, "", input.summaryText].join("\n")
  const protectedTailText = renderProtectedTailMessages(input.protectedTailMessages)

  if (!protectedTailText) {
    return summaryBody
  }

  return [summaryBody, "", COMPACTION_TAIL_HEADING, "", protectedTailText].join("\n")
}

function renderProtectedTailMessages(messages: OrchestrationTranscriptMessage[]) {
  const rendered = messages
    .map((message) => {
      const text = renderProtectedTailMessage(message)
      return text ? `### ${message.role.toUpperCase()}\n${text}` : null
    })
    .filter((value): value is string => value !== null)

  return rendered.length > 0 ? rendered.join("\n\n") : null
}

function renderProtectedTailMessage(message: OrchestrationTranscriptMessage) {
  const renderedParts = message.parts
    .map((part) => renderProtectedTailPart(part))
    .filter((value): value is string => value !== null)

  return renderedParts.length > 0 ? renderedParts.join("\n") : null
}

function renderProtectedTailPart(part: OrchestrationTranscriptPart) {
  if (part.kind === "tool_call") {
    const data = readObject(part.data)
    const toolName = readString(data, "toolName") ?? "unknown"
    const inputText = readString(data, "inputText") ?? part.text ?? ""
    return `[tool_call:${toolName}] ${inputText}`.trimEnd()
  }

  if (part.kind === "tool_result") {
    const data = readObject(part.data)
    const toolName = readString(data, "toolName") ?? "unknown"
    const output = part.text ?? readString(data, "output") ?? ""
    return `[tool_result:${toolName}] ${output}`.trimEnd()
  }

  if (part.kind === "error") {
    return `Error: ${part.text ?? "unknown error"}`
  }

  return part.text?.trim() ? part.text : null
}

function extractPreviousCompactionSummary(message: OrchestrationTranscriptMessage | null) {
  const summaryText =
    message?.parts.find((part) => part.kind === "text" && part.text?.trim())?.text ?? null
  if (!summaryText) {
    return null
  }

  let normalized = summaryText.trim()
  if (normalized.startsWith(COMPACTION_HANDOFF_FRAMING)) {
    normalized = normalized.slice(COMPACTION_HANDOFF_FRAMING.length).trimStart()
  }

  const tailHeadingIndex = normalized.indexOf(`\n${COMPACTION_TAIL_HEADING}`)
  if (tailHeadingIndex >= 0) {
    normalized = normalized.slice(0, tailHeadingIndex).trimEnd()
  }

  return normalized
}

function findLatestCompactionBoundaryIndex(transcript: OrchestrationTranscriptMessage[]) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.parts.some((part) => part.kind === "compaction_boundary")) {
      return index
    }
  }

  return -1
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

function hasPendingRecoveryContext(reminderBatch: SkillReminderBatch | undefined) {
  return Boolean(
    reminderBatch &&
      (reminderBatch.recoveryFilePaths.length > 0 || reminderBatch.activeSkillNames.length > 0),
  )
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

      if (eventType === "compaction.failed" && readString(data, "trigger") === "auto") {
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

function readLatestCompactionBoundaryTrigger(transcript: OrchestrationTranscriptMessage[]) {
  for (let messageIndex = transcript.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = transcript[messageIndex]
    if (!message) {
      continue
    }

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]
      if (!part || part.kind !== "compaction_boundary") {
        continue
      }

      const trigger = readString(readObject(part.data), "trigger")
      if (trigger === "manual" || trigger === "auto") {
        return trigger
      }
    }
  }

  return null
}

function createTurnKey(runId: string, messageSequence: number) {
  return `${runId}:turn_${messageSequence}`
}

function getNextMessageSequence(transcript: OrchestrationTranscriptMessage[], runId: string) {
  const highestSequence = transcript
    .filter((message) => message.runId === runId)
    .reduce((value, message) => Math.max(value, message.sequence), -1)

  return highestSequence + 1
}

function recordObservedRuntimeEvent(input: {
  runtimeObserver?: OrchestrationRuntimeObserverPort
  sessionId: string
  runId: string
  event: RuntimeObserverEvent
  occurredAt: number
}) {
  input.runtimeObserver?.recordRuntimeEvent?.({
    sessionId: input.sessionId,
    runId: input.runId,
    event: input.event,
    occurredAt: input.occurredAt,
  })
}

function stripAnalysisBlocks(text: string) {
  return text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
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

function readObject(value: unknown) {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function readString(value: Record<string, unknown> | null, key: string) {
  return typeof value?.[key] === "string" ? (value[key] as string) : null
}

function readNumber(value: Record<string, unknown> | null, key: string) {
  return typeof value?.[key] === "number" ? (value[key] as number) : null
}
