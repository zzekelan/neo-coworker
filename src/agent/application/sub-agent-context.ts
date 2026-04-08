import type { AgentProfile } from "../domain/agent-profile"
import type {
  AgentContextWindowPort,
  AgentModelPort,
  AgentRuntimeEvent,
  AgentRuntimeObserverPort,
  AgentSessionPort,
  AgentSkillPort,
  AgentToolBatchExecutor,
  AgentToolDefinition,
  AgentToolPort,
  CreateAgentStepService,
  CreateAgentToolBatchExecutor,
  CreateAgentToolProvider,
  CreateAgentToolRuntime,
} from "./ports/sub-agent-runtime"
import { filterToolsForAgent, loadSkillsForAgent } from "./tool-filter"

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
  createQueuedRun(input: {
    subRunId: string
    sessionId: string
    prompt: string
    activeSkills: string[]
    createdAt: number
  }): void
  runtimeObserver?: AgentRuntimeObserverPort
  now?: () => number
  signal?: AbortSignal
  buildAgentAwarePrompt(profile?: AgentProfile): string
  createStepService: CreateAgentStepService
  createToolBatchExecutor: CreateAgentToolBatchExecutor
  createToolRuntime: CreateAgentToolRuntime
  createToolProvider: CreateAgentToolProvider
}

export async function createSubAgentRun(input: CreateSubAgentRunInput): Promise<string> {
  const now = input.now ?? Date.now
  const context = createSubAgentContext({
    sessionId: input.sessionId,
    signal: input.signal,
  })
  const activeSkills = [...new Set((input.profile.skills ?? []).filter((skill) => skill.trim().length > 0))]
  const scopedSkillPort = createScopedSkillPort({
    skill: input.skill,
    allowedSkillNames: activeSkills,
    agentName: input.profile.name,
    workspaceRoot: input.workspaceRoot,
  })
  const skillTools = await loadSkillsForAgent(input.profile, scopedSkillPort)
  const tools = createScopedToolPort({
    parentTools: input.parentTools,
    profile: input.profile,
    skillTools,
    createToolBatchExecutor: input.createToolBatchExecutor,
    createToolRuntime: input.createToolRuntime,
    createToolProvider: input.createToolProvider,
  })
  const session = createScopedSessionPort({
    session: input.session,
    sessionId: input.sessionId,
    activeSkills,
    subRunId: context.subRunId,
  })
  const stepService = input.createStepService({
    session,
    model: input.model,
    contextWindow: input.contextWindow,
    skill: scopedSkillPort,
    runtimeObserver: input.runtimeObserver,
    now,
  })
  const maxTurns = input.profile.maxTurns ?? 10
  const emit = (event: AgentRuntimeEvent) => {
    recordRuntimeEvent({
      runtimeObserver: input.runtimeObserver,
      sessionId: input.sessionId,
      runId: context.subRunId,
      occurredAt: now(),
      event,
    })
  }

  recordRuntimeEvent({
    runtimeObserver: input.runtimeObserver,
    sessionId: input.sessionId,
    runId: context.subRunId,
    occurredAt: now(),
    event: {
      type: "subagent.started",
      agentName: input.profile.name,
      parentRunId: input.parentRunId,
      subRunId: context.subRunId,
      maxTurns,
    },
  })

  input.createQueuedRun({
    subRunId: context.subRunId,
    sessionId: input.sessionId,
    prompt: input.prompt,
    activeSkills,
    createdAt: now(),
  })

  const systemPrompt = input.buildAgentAwarePrompt(input.profile)

  try {
    if (context.signal.aborted) {
      stepService.cancelRun({
        runId: context.subRunId,
        emit,
      })
      throw createAbortError()
    }

    stepService.initializeRun({
      sessionId: input.sessionId,
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
        sessionId: input.sessionId,
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
        session,
        sessionId: input.sessionId,
        runId: context.subRunId,
      })
      recordRuntimeEvent({
        runtimeObserver: input.runtimeObserver,
        sessionId: input.sessionId,
        runId: context.subRunId,
        occurredAt: now(),
        event: {
          type: "subagent.completed",
          agentName: input.profile.name,
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

    throw error
  }
}

function createScopedSessionPort(input: {
  session: AgentSessionPort
  sessionId: string
  activeSkills: string[]
  subRunId: string
}): AgentSessionPort {
  return {
    storageIdentity: input.session.storageIdentity,
    getSession(sessionId) {
      const session = input.session.getSession(sessionId)

      if (sessionId !== input.sessionId) {
        return session
      }

      return {
        ...session,
        activeSkills: [...input.activeSkills],
      }
    },
    getRun(runId) {
      return input.session.getRun(runId)
    },
    listTranscript(sessionId) {
      const transcript = input.session.listTranscript(sessionId)

      if (sessionId !== input.sessionId) {
        return transcript
      }

      return transcript.filter((message) => message.runId === input.subRunId)
    },
    createRun(run) {
      return input.session.createRun(run)
    },
    createAssistantMessage(message) {
      return input.session.createAssistantMessage(message)
    },
    createSyntheticMessage(message) {
      return input.session.createSyntheticMessage(message)
    },
    createMessagePart(part) {
      return input.session.createMessagePart(part)
    },
    updateMessagePart(update) {
      return input.session.updateMessagePart(update)
    },
    recordRunTokenUsage(update) {
      return input.session.recordRunTokenUsage(update)
    },
    transitionRunToRunning(runId) {
      return input.session.transitionRunToRunning(runId)
    },
    completeRun(runId) {
      return input.session.completeRun(runId)
    },
    failRun(run) {
      return input.session.failRun(run)
    },
    cancelRun(runId) {
      return input.session.cancelRun(runId)
    },
  }
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
      return catalog.filter((skill) => allowed.has(skill.name))
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

function createScopedToolPort(input: {
  parentTools: AgentToolPort
  profile: AgentProfile
  skillTools: AgentToolDefinition[]
  createToolBatchExecutor: () => AgentToolBatchExecutor
  createToolRuntime: CreateAgentToolRuntime
  createToolProvider: CreateAgentToolProvider
}): AgentToolPort {
  const batchExecutor = input.createToolBatchExecutor()
  const filteredTools = filterToolsForAgent(createForwardedTools(input.parentTools), input.profile)
  const runtime = input.createToolRuntime({
    tools: dedupeToolsByName([...filteredTools, ...input.skillTools]),
  })
  const provider = input.createToolProvider({ runtime })

  return {
    list() {
      return provider.list()
    },
    execute(value) {
      return provider.execute(value)
    },
    async executeBatch(batchInput) {
      return batchExecutor.execute({
        calls: batchInput.calls,
        tools: provider,
        availableTools: runtime.list(),
        workspaceRoot: batchInput.workspaceRoot,
        signal: batchInput.signal,
      })
    },
  }
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

function getFinalAssistantText(input: {
  session: AgentSessionPort
  sessionId: string
  runId: string
}) {
  const messages = input.session
    .listTranscript(input.sessionId)
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
