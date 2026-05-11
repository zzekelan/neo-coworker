import type { AgentProfile } from "../domain/agent-profile"
import type {
  AgentContextWindowPort,
  AgentModelPort,
  AgentRuntimeEvent,
  AgentRuntimeObserverPort,
  AgentSessionPort,
  AgentSkillPort,
  AgentToolBatchExecutor,
  AgentToolBatchResult,
  AgentToolCatalogEntry,
  AgentToolDefinition,
  AgentToolPort,
  CreateAgentStepService,
  CreateAgentToolBatchExecutor,
  CreateAgentToolProvider,
  CreateAgentToolRuntime,
} from "./ports/sub-agent-runtime"
import { filterToolsForAgent, loadSkillsForAgent } from "./tool-filter"

const DEFAULT_SUBAGENT_MAX_TURNS = 50
const SUBAGENT_TOOL_RESULT_SIZE_LIMIT = 50_000

type ResultStore = {
  save(content: string, toolName: string): { path: string } | undefined
}

type ToolObserverPort = {
  recordToolEvent?(event: any): void
}

type AgentToolResultManager = {
  manageBatchResult(input: {
    result: AgentToolBatchResult
    tool?: Pick<AgentToolDefinition, "name" | "resultSizeLimit">
    limit: number
    workspaceRoot: string
    sessionId: string
    runId: string
    toolObserver?: ToolObserverPort
    resultStore?: ResultStore
  }): AgentToolBatchResult
  applyTurnBudget(input: {
    rawResults: AgentToolBatchResult[]
    managedResults: AgentToolBatchResult[]
    sessionId: string
    runId: string
    toolObserver?: ToolObserverPort
    resultStore?: ResultStore
  }): AgentToolBatchResult[]
}

export function createSubAgentContext(input: { sessionId: string; signal?: AbortSignal }) {
  const controller = new AbortController()

  if (input.signal?.aborted) {
    controller.abort(input.signal.reason)
  } else {
    input.signal?.addEventListener(
      "abort",
      () => {
        controller.abort(input.signal?.reason)
      },
      { once: true },
    )
  }

  return {
    subRunId: `run_${crypto.randomUUID()}`,
    sessionId: input.sessionId,
    signal: controller.signal,
  }
}

export type CreateSubAgentRunInput = {
  profile: AgentProfile
  prompt: string
  sessionId: string
  parentRunId: string
  workspaceRoot: string
  parentTools: AgentToolPort
  model: AgentModelPort
  session: AgentSessionPort
  skill: AgentSkillPort
  contextWindow: AgentContextWindowPort
  thinking?: Parameters<CreateAgentStepService>[0]["thinking"]
  resolveThinking?: Parameters<CreateAgentStepService>[0]["resolveThinking"]
  createQueuedRun(input: {
    subRunId: string
    sessionId: string
    prompt: string
    activeSkills: string[]
    createdAt: number
    parentRunId: string
  }): { subSessionId: string }
  runtimeObserver?: AgentRuntimeObserverPort
  now?: () => number
  signal?: AbortSignal
  buildAgentAwarePrompt(profile?: AgentProfile, toolGuidances?: AgentToolGuidanceEntry[]): string
  createStepService: CreateAgentStepService
  createToolBatchExecutor: CreateAgentToolBatchExecutor
  createToolRuntime: CreateAgentToolRuntime
  createToolProvider: CreateAgentToolProvider
  toolObserver?: ToolObserverPort
  toolResultManager?: AgentToolResultManager
  createResultStore?(input: {
    workspaceRoot: string
    sessionId: string
    runId: string
  }): ResultStore
}

type AgentToolGuidanceEntry = {
  name: string
  guidance: string
  isReadOnly: boolean
}

type ScopedSkillCatalogEntry = Awaited<ReturnType<AgentSkillPort["listCatalog"]>>[number] & {
  overrides?: Array<{ path: string }>
}

export async function createSubAgentRun(input: CreateSubAgentRunInput): Promise<string> {
  const now = input.now ?? Date.now
  const context = createSubAgentContext({
    sessionId: input.sessionId,
    signal: input.signal,
  })
  const requestedSkills = normalizeSkillNames(input.profile.skills)
  const activeSkills =
    requestedSkills.length > 0
      ? requestedSkills
      : normalizeSkillNames(input.session.getSession(input.sessionId).activeSkills)
  const scopedSkillPort = createScopedSkillPort({
    skill: input.skill,
    allowedSkillNames: activeSkills,
    agentName: input.profile.name,
    workspaceRoot: input.workspaceRoot,
  })
  const startupSkillPort = createStartupSkillFailureReportingPort({
    skill: scopedSkillPort,
    profile: input.profile,
    sessionId: input.sessionId,
    runId: context.subRunId,
    parentRunId: input.parentRunId,
    subRunId: context.subRunId,
    runtimeObserver: input.runtimeObserver,
    now,
  })
  const skillTools = await loadSkillsForAgent(
    {
      ...input.profile,
      skills: activeSkills,
    },
    startupSkillPort,
  )
  const stepService = input.createStepService({
    session: input.session,
    model: input.model,
    contextWindow: input.contextWindow,
    skill: scopedSkillPort,
    thinking: input.thinking,
    resolveThinking: input.resolveThinking
      ? () => input.resolveThinking?.(input.sessionId)
      : undefined,
    runtimeObserver: createCorrelatedRuntimeObserver({
      runtimeObserver: input.runtimeObserver,
    }),
    now,
  })
  const maxTurns = input.profile.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS

  const { subSessionId } = input.createQueuedRun({
    subRunId: context.subRunId,
    sessionId: input.sessionId,
    prompt: input.prompt,
    activeSkills,
    createdAt: now(),
    parentRunId: input.parentRunId,
  })
  const resultStore = input.createResultStore?.({
    workspaceRoot: input.workspaceRoot,
    sessionId: subSessionId,
    runId: context.subRunId,
  })
  const tools = createScopedToolPort({
    parentTools: input.parentTools,
    profile: input.profile,
    skillTools,
    createToolBatchExecutor: input.createToolBatchExecutor,
    createToolRuntime: input.createToolRuntime,
    createToolProvider: input.createToolProvider,
    workspaceRoot: input.workspaceRoot,
    sessionId: subSessionId,
    runId: context.subRunId,
    toolObserver: input.toolObserver,
    toolResultManager: input.toolResultManager,
    resultStore,
  })
  const emit = (event: AgentRuntimeEvent) => {
    recordRuntimeEvent({
      runtimeObserver: input.runtimeObserver,
      sessionId: subSessionId,
      runId: context.subRunId,
      occurredAt: now(),
      event,
    })
  }

  recordRuntimeEvent({
    runtimeObserver: input.runtimeObserver,
    sessionId: subSessionId,
    runId: context.subRunId,
    occurredAt: now(),
    event: {
      type: "subagent.started",
      agentId: input.profile.name,
      displayName: input.profile.displayName ?? input.profile.name,
      status: "started",
      parentRunId: input.parentRunId,
      subRunId: context.subRunId,
      maxTurns,
    },
  })

  const systemPrompt = input.buildAgentAwarePrompt(input.profile, deriveToolGuidanceEntries(tools.list()))

  try {
    if (context.signal.aborted) {
      stepService.cancelRun({
        runId: context.subRunId,
        emit,
      })
      throw createAbortError()
    }

    stepService.initializeRun({
      sessionId: subSessionId,
      runId: context.subRunId,
      emit,
    })

    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (context.signal.aborted) {
        stepService.cancelRun({
          runId: context.subRunId,
          emit,
        })
        throw createAbortError()
      }

      const outcome = await stepService.executeStep({
        sessionId: subSessionId,
        runId: context.subRunId,
        tools,
        workspaceRoot: input.workspaceRoot,
        systemPrompt,
        signal: context.signal,
        emit,
      })

      if (outcome.status === "repeat") {
        continue
      }

      if (outcome.status === "failed") {
        stepService.failRun({
          runId: context.subRunId,
          error: outcome.error,
          emit,
        })
        throw new Error(outcome.error)
      }

      if (outcome.status === "cancelled") {
        stepService.cancelRun({
          runId: context.subRunId,
          emit,
        })
        throw createAbortError("Sub-agent run cancelled")
      }

      stepService.completeRun({
        runId: context.subRunId,
        emit,
      })

      const output = getFinalAssistantText({
        session: input.session,
        sessionId: subSessionId,
        runId: context.subRunId,
      })
      recordRuntimeEvent({
        runtimeObserver: input.runtimeObserver,
        sessionId: subSessionId,
        runId: context.subRunId,
        occurredAt: now(),
        event: {
          type: "subagent.completed",
          agentId: input.profile.name,
          displayName: input.profile.displayName ?? input.profile.name,
          status: "completed",
          parentRunId: input.parentRunId,
          subRunId: context.subRunId,
          outputLength: output.length,
        },
      })
      return output
    }

    const error = `Sub-agent '${input.profile.name}' reached turn limit (${maxTurns}).`
    stepService.failRun({
      runId: context.subRunId,
      error,
      emit,
    })
    throw new Error(error)
  } catch (error) {
    if (stepService.isAbortError(error, context.signal)) {
      throw error
    }

    if (stepService.isDetachedError(error)) {
      throw error
    }

    recordRuntimeEvent({
      runtimeObserver: input.runtimeObserver,
      sessionId: subSessionId,
      runId: context.subRunId,
      occurredAt: now(),
      event: {
        type: "subagent.failed",
        agentId: input.profile.name,
        displayName: input.profile.displayName ?? input.profile.name,
        status: "failed",
        parentRunId: input.parentRunId,
        subRunId: context.subRunId,
        errorCode: "SUBAGENT_FAILED",
        errorMessage: redactDiagnosticMessage(getErrorMessage(error)),
      },
    })

    throw error
  }
}

function createStartupSkillFailureReportingPort(input: {
  skill: AgentSkillPort
  profile: AgentProfile
  sessionId: string
  runId: string
  parentRunId: string
  subRunId: string
  runtimeObserver?: AgentRuntimeObserverPort
  now: () => number
}): AgentSkillPort {
  return {
    listCatalog(workspaceRoot) {
      return input.skill.listCatalog(workspaceRoot)
    },
    async loadSkill(value) {
      try {
        return await input.skill.loadSkill(value)
      } catch (error) {
        const errorMessage = redactDiagnosticMessage(getErrorMessage(error))
        recordRuntimeEvent({
          runtimeObserver: input.runtimeObserver,
          sessionId: input.sessionId,
          runId: input.runId,
          occurredAt: input.now(),
          event: {
            type: "skill.load.failed",
            status: "failed",
            skillName: value.name,
            agentId: input.profile.name,
            displayName: input.profile.displayName ?? input.profile.name,
            parentRunId: input.parentRunId,
            subRunId: input.subRunId,
            errorCode: "SKILL_LOAD_FAILED",
            errorMessage,
            reason: "startup",
          },
        })
        throw error
      }
    },
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function redactDiagnosticMessage(message: string) {
  return message
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*[^\s;,]+/g,
      "$1=[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "sk-[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@")
}

function createScopedSkillPort(input: {
  skill: AgentSkillPort
  allowedSkillNames: string[]
  agentName: string
  workspaceRoot: string
}): AgentSkillPort {
  const allowed = new Set(input.allowedSkillNames)

  return {
    async listCatalog(workspaceRoot) {
      const catalog = await input.skill.listCatalog(workspaceRoot)
      return catalog.filter((skill) => input.allowedSkillNames.some((name) => skillCatalogEntryMatchesName(skill, name)))
    },
    async loadSkill(value) {
      if (!allowed.has(value.name)) {
        throw new Error(`Skill '${value.name}' is not allowed for agent '${input.agentName}'.`)
      }

      return input.skill.loadSkill({
        workspaceRoot: input.workspaceRoot,
        name: value.name,
      })
    },
  }
}

function skillCatalogEntryMatchesName(
  skill: ScopedSkillCatalogEntry,
  skillName: string,
) {
  return (
    skill.name === skillName ||
    skillCatalogPathMatchesName(skill.path, skillName) ||
    (skill.overrides ?? []).some((override) => skillCatalogPathMatchesName(override.path, skillName))
  )
}

function skillCatalogPathMatchesName(path: string, skillName: string) {
  const packagePath = `${skillName}/SKILL.md`

  return path === `.ncoworker/skills/${packagePath}` || path === packagePath || path.endsWith(`:${packagePath}`)
}

function createScopedToolPort(input: {
  parentTools: AgentToolPort
  profile: AgentProfile
  skillTools: AgentToolDefinition[]
  createToolBatchExecutor: () => AgentToolBatchExecutor
  createToolRuntime: CreateAgentToolRuntime
  createToolProvider: CreateAgentToolProvider
  workspaceRoot: string
  sessionId: string
  runId: string
  toolObserver?: ToolObserverPort
  toolResultManager?: AgentToolResultManager
  resultStore?: ResultStore
}): AgentToolPort {
  const batchExecutor = input.createToolBatchExecutor()
  const scopedTools = dedupeToolsByName([
    ...filterToolsForAgent(createForwardedTools(input.parentTools), input.profile),
    ...input.skillTools,
  ])
  const runtime = input.createToolRuntime({
    tools: scopedTools,
  })
  const provider = input.createToolProvider({ runtime })
  const resultManager = input.toolResultManager ?? defaultAgentToolResultManager

  return {
    list() {
      return provider.list()
    },
    execute(value) {
      return provider.execute(value)
    },
    async executeBatch(batchInput) {
      const results = await batchExecutor.execute({
        calls: batchInput.calls,
        tools: provider,
        availableTools: runtime.list(),
        workspaceRoot: batchInput.workspaceRoot,
        signal: batchInput.signal,
      })

      const managedResults = results.map((result) => resultManager.manageBatchResult({
        result,
        tool: scopedTools.find((candidate) => candidate.name === result.toolName),
        limit: SUBAGENT_TOOL_RESULT_SIZE_LIMIT,
        workspaceRoot: input.workspaceRoot,
        sessionId: input.sessionId,
        runId: input.runId,
        toolObserver: input.toolObserver,
        resultStore: input.resultStore,
      }))

      return resultManager.applyTurnBudget({
        rawResults: results,
        managedResults,
        sessionId: input.sessionId,
        runId: input.runId,
        toolObserver: input.toolObserver,
        resultStore: input.resultStore,
      })
    },
  }
}

const defaultAgentToolResultManager: AgentToolResultManager = {
  manageBatchResult(input) {
    const result = input.result

    if (result.isError) {
      return result
    }

    const limit = input.limit
    const originalSize = Buffer.byteLength(result.output, "utf8")

    if (originalSize <= limit) {
      return result
    }

    const truncated = Buffer.from(result.output, "utf8").subarray(0, limit).toString("utf8")
    const truncatedSize = Buffer.byteLength(truncated, "utf8")
    const savedPath = saveOversizedAgentToolResult({
      resultStore: input.resultStore,
      toolName: result.toolName,
      output: result.output,
    })?.path

    if (savedPath) {
      recordAgentToolEvent(input.toolObserver, {
        type: "budget.result_truncated",
        sessionId: input.sessionId,
        runId: input.runId,
        toolName: result.toolName,
        originalSize,
        truncatedSize,
        limit,
        savedPath,
      })
    }

    return {
      ...result,
      output: `${truncated}${formatAgentToolTruncationSuffix({ originalSize, truncatedSize, savedPath })}`,
      metadata: {
        ...result.metadata,
        truncated: true,
        originalSize,
        truncatedSize,
        resultSizeLimit: limit,
        savedPath,
      },
    }
  },
  applyTurnBudget(input) {
    const trackedResults: Array<{
      position: number
      toolName: string
      content: string
      size: number
      spilled: boolean
    }> = []
    let totalSize = 0
    let overBudgetEmitted = false

    for (const result of input.rawResults) {
      if (result.isError) {
        continue
      }

      const size = result.output.length
      trackedResults.push({
        position: trackedResults.length,
        toolName: result.toolName,
        content: result.output,
        size,
        spilled: false,
      })
      totalSize += size

      if (totalSize > 200_000 && !overBudgetEmitted) {
        overBudgetEmitted = true
        recordAgentToolEvent(input.toolObserver, {
          type: "budget.turn_over_budget",
          sessionId: input.sessionId,
          runId: input.runId,
          turnCumulativeSize: totalSize,
          maxChars: 200_000,
          trackedToolCount: trackedResults.length,
        })
      }
    }

    if (totalSize <= 200_000 || !input.resultStore) {
      return input.managedResults
    }

    const spilledResults: Array<{
      position: number
      path: string
      output: string
      originalSize: number
      previewSize: number
    }> = []

    while (totalSize > 200_000) {
      const candidate = trackedResults
        .filter((result) => !result.spilled)
        .sort((left, right) => right.size - left.size)[0]

      if (!candidate) {
        break
      }

      const saved = input.resultStore.save(candidate.content, candidate.toolName)
      if (!saved) {
        break
      }

      const originalSize = candidate.size
      const preview = candidate.content.slice(0, 500)
      const output = `${preview}\n\n[Result spilled to ${saved.path} to stay within the per-turn tool budget.]`
      const previewSize = output.length

      if (previewSize >= originalSize) {
        break
      }

      candidate.content = output
      candidate.size = previewSize
      candidate.spilled = true
      totalSize = totalSize - originalSize + previewSize
      recordAgentToolEvent(input.toolObserver, {
        type: "budget.spill_largest",
        sessionId: input.sessionId,
        runId: input.runId,
        toolName: candidate.toolName,
        spilledSize: originalSize,
        previewLength: 500,
        diskPath: saved.path,
        remainingBudget: Math.max(0, 200_000 - totalSize),
      })
      spilledResults.push({
        position: candidate.position,
        path: saved.path,
        output,
        originalSize,
        previewSize,
      })
    }

    if (spilledResults.length === 0) {
      return input.managedResults
    }

    const spilledByPosition = new Map(spilledResults.map((entry) => [entry.position, entry]))

    return input.managedResults.map((result, index) => {
      const spilled = spilledByPosition.get(index)
      if (!spilled) {
        return result
      }

      return {
        ...result,
        output: spilled.output,
        metadata: {
          ...result.metadata,
          spilledToDisk: true,
          savedPath: spilled.path,
          originalSize: spilled.originalSize,
          truncatedSize: spilled.previewSize,
        },
      }
    })
  },
}

function saveOversizedAgentToolResult(input: {
  resultStore?: ResultStore
  toolName: string
  output: string
}) {
  try {
    return input.resultStore?.save(input.output, input.toolName)
  } catch {
    return undefined
  }
}

function formatAgentToolTruncationSuffix(input: {
  originalSize: number
  truncatedSize: number
  savedPath?: string
}) {
  if (input.savedPath) {
    return `\n\n[Result truncated: ${input.originalSize}B → ${input.truncatedSize}B. Full result saved to ${input.savedPath}]`
  }

  return `\n\n[Result truncated: ${input.originalSize}B → ${input.truncatedSize}B. Full result was not persisted in this context.]`
}

function recordAgentToolEvent(observer: ToolObserverPort | undefined, event: any) {
  try {
    observer?.recordToolEvent?.(event)
  } catch {}
}

function createForwardedTools(parentTools: AgentToolPort): AgentToolDefinition[] {
  return parentTools.list().map((tool) => ({
    ...tool,
    async execute(input) {
      return parentTools.execute({
        toolName: tool.name,
        args: input.args,
        workspaceRoot: input.workspaceRoot,
        signal: input.signal,
        onProgress: input.onProgress,
      })
    },
  }))
}

function dedupeToolsByName(tools: AgentToolDefinition[]) {
  const byName = new Map<string, AgentToolDefinition>()

  for (const tool of tools) {
    byName.set(tool.name, tool)
  }

  return [...byName.values()]
}

function deriveToolGuidanceEntries(tools: AgentToolCatalogEntry[]): AgentToolGuidanceEntry[] {
  return tools.flatMap((tool) => {
    const guidance = tool.usageGuidance?.trim()

    if (!guidance) {
      return []
    }

    return [{
      name: tool.name,
      guidance,
      isReadOnly: tool.concurrency === "read-only",
    } satisfies AgentToolGuidanceEntry]
  })
}

function getFinalAssistantText(input: {
  session: AgentSessionPort
  sessionId: string
  runId: string
}) {
  const messages = input.session
    .listTimeline(input.sessionId)
    .filter((message) => message.runId === input.runId && message.role === "assistant")

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index]!.parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text ?? "")
      .join("")

    if (text.length > 0) {
      return text
    }
  }

  return ""
}

function createCorrelatedRuntimeObserver(input: {
  runtimeObserver?: AgentRuntimeObserverPort
}): AgentRuntimeObserverPort | undefined {
  if (!input.runtimeObserver) {
    return undefined
  }

  return {
    recordRuntimeEvent(eventInput) {
      input.runtimeObserver?.recordRuntimeEvent?.(eventInput)
    },
  }
}

function normalizeSkillNames(skillNames: readonly string[] | null | undefined) {
  return [...new Set((skillNames ?? []).filter((skill) => skill.trim().length > 0))]
}

function recordRuntimeEvent(input: {
  runtimeObserver?: AgentRuntimeObserverPort
  sessionId: string
  runId: string
  event: AgentRuntimeEvent
  occurredAt: number
}) {
  try {
    input.runtimeObserver?.recordRuntimeEvent?.({
      sessionId: input.sessionId,
      runId: input.runId,
      event: input.event,
      occurredAt: input.occurredAt,
    })
  } catch (_error) {
    return
  }
}

function createAbortError(message = "Operation aborted") {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}
