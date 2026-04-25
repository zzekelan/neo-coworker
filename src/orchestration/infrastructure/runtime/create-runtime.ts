import { createOrchestrationStepService } from "../../application/step-service"
import { DEFAULT_CONTEXT_WINDOW_SIZE as DEFAULT_ORCHESTRATION_CONTEXT_WINDOW_SIZE } from "../../application/context-usage"
import {
  buildStaticPromptAssembly,
  type StaticPromptAssembly,
  type ToolGuidanceEntry,
} from "../../application/prompt-composer"
import type { RuntimeEvent } from "../../application/event"
import type { OrchestrationRunHandle } from "../../application/handle"
import type { OrchestrationAgentProfilePort } from "../../application/ports/agent-profile"
import type { OrchestrationContextWindowPort } from "../../application/ports/context-window"
import type { OrchestrationModelPort } from "../../application/ports/model"
import type {
  OrchestrationPermissionPort,
  OrchestrationPermissionResponse,
} from "../../application/ports/permission"
import type { OrchestrationSessionPort } from "../../application/ports/session"
import type { OrchestrationSkillPort } from "../../application/ports/skill"
import type {
  OrchestrationTool,
  OrchestrationToolPort,
  OrchestrationToolPortFactory,
} from "../../application/ports/tool"
import type { OrchestrationRuntimeObserverPort } from "../../application/ports/runtime-observer"
import type { OrchestrationPermissionPolicy } from "../../application/permission"
import {
  type OrchestrationActiveRunRegistry,
} from "./active-run-registry"
import { createEventQueue } from "./event-queue"
import { runOrchestrationLoop } from "./loop"
import {
  createRunSuspension,
  PermissionRequestNotAwaitingActiveRuntimeError,
} from "./run-suspension"

export type CreateOrchestrationRuntimeApiInput = {
  model: OrchestrationModelPort
  session: OrchestrationSessionPort
  agentProfiles?: OrchestrationAgentProfilePort
  skill: OrchestrationSkillPort
  contextWindow?: OrchestrationContextWindowPort
  thinking?: {
    enabled: boolean
    effort?: "default" | "low" | "medium" | "high"
  }
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
  permission: OrchestrationPermissionPort
  tools: OrchestrationToolPortFactory
  activeRuns: OrchestrationActiveRunRegistry
  permissionPolicy: OrchestrationPermissionPolicy
  systemPrompt?: string
  buildSystemPrompt?: (input: {
    sessionId: string
    runId: string
    session: CreateOrchestrationRuntimeApiInput["session"]["getSession"] extends (
      sessionId: string
    ) => infer T
      ? T
      : never
    now: () => number
    tools: ReturnType<OrchestrationToolPort["list"]>
  }) =>
    | Promise<BuildSystemPromptResult>
    | BuildSystemPromptResult
  now?: () => number
  runtimeObserver?: OrchestrationRuntimeObserverPort
}

type ThinkingConfig = NonNullable<CreateOrchestrationRuntimeApiInput["thinking"]>

type BuildSystemPromptResult =
  | string
  | StaticPromptAssembly
  | {
      assembly: string | StaticPromptAssembly
      afterInitialize?: () => void | Promise<void>
    }

export type OrchestrationRunInput = {
  sessionId: string
  runId: string
}

export function createOrchestrationRuntimeApi(input: CreateOrchestrationRuntimeApiInput) {
  const now = input.now ?? Date.now
  const activeRuns = input.activeRuns
  const sessionThinkingOverrides = new Map<string, ThinkingConfig | null>()
  const contextWindow = input.contextWindow ?? {
    getContextWindow() {
      return DEFAULT_ORCHESTRATION_CONTEXT_WINDOW_SIZE
    },
  }
  const resolveThinking = (sessionId: string) => {
    return sessionThinkingOverrides.has(sessionId)
      ? sessionThinkingOverrides.get(sessionId) ?? undefined
      : input.thinking
  }
  const stepService = createOrchestrationStepService({
    session: input.session,
    model: input.model,
    agentProfiles: input.agentProfiles,
    contextWindow,
    skill: input.skill,
    thinking: input.thinking,
    resolveThinking,
    telemetry: input.telemetry,
    runtimeObserver: input.runtimeObserver,
    now,
  })

  function buildActiveRunKey(sessionId: string, runId: string) {
    return {
      storageIdentity: input.session.storageIdentity,
      sessionId,
      runId,
    }
  }

  function cancelOutstandingPendingRequests(runId: string, suspend?: { getPendingRequestIds(): string[] }) {
    if (suspend && suspend.getPendingRequestIds().length === 0) {
      return []
    }

    return input.permission.cancelPendingRequestsByRun(runId, now())
  }

  function throwPermissionRequestNotAwaitingActiveRuntime(
    permissionRequest: ReturnType<CreateOrchestrationRuntimeApiInput["permission"]["getPermissionRequest"]>,
  ): never {
    throw new PermissionRequestNotAwaitingActiveRuntimeError({
      requestId: permissionRequest.id,
      runId: permissionRequest.runId,
      sessionId: permissionRequest.sessionId,
      status: permissionRequest.status,
    })
  }

  async function createActiveRunExecution(inputValue: {
    sessionId: string
    runId: string
  }) {
    const activeRunKey = buildActiveRunKey(inputValue.sessionId, inputValue.runId)

    if (activeRuns.has(activeRunKey)) {
      throw new Error(`Run ${inputValue.runId} is already active`)
    }

    const session = input.session.getSession(inputValue.sessionId)
    const controller = new AbortController()
    const queue = createEventQueue<RuntimeEvent>()
    const emit = (event: RuntimeEvent) => {
      queue.push(event)
      try {
        input.runtimeObserver?.recordRuntimeEvent?.({
          sessionId: session.id,
          runId: inputValue.runId,
          event,
          occurredAt: now(),
        })
      } catch {
        // Observability must not alter the live event stream.
      }
    }
    const suspend = createRunSuspension({
      permission: input.permission,
      runId: inputValue.runId,
      sessionId: session.id,
      policy: input.permissionPolicy,
      now,
      emit,
    })
    const activeRun = {
      ...activeRunKey,
      controller,
      suspend,
      emit,
    }

    activeRuns.add(activeRun)

    const tools = input.tools.create({
      requestPermission(request) {
        return suspend.requestPermission(request)
      },
      sessionId: session.id,
      runId: inputValue.runId,
      resolveThinking,
      forwardRuntimeEvent(event) {
        queue.push(event as RuntimeEvent)
      },
    })
    const promptBuildResult =
      input.systemPrompt
        ? input.systemPrompt
        : await (input.buildSystemPrompt?.({
            sessionId: session.id,
            runId: inputValue.runId,
            session,
            now,
            tools: tools.listCatalog?.() ?? tools.list(),
          }) ??
          buildDefaultSystemPrompt({
            session,
            now,
            tools: tools.listCatalog?.() ?? tools.list(),
          }))
    const resolvedPromptBuild = resolvePromptBuildResult(promptBuildResult)
    const promptAssembly = resolvePromptAssembly(resolvedPromptBuild.assembly)
    const defaultSystemPrompt = promptAssembly.prompt

    return {
      activeRunKey,
      controller,
      defaultSystemPrompt,
      emit,
      queue,
      session,
      suspend,
      tools,
      afterInitialize: resolvedPromptBuild.afterInitialize,
      cleanup() {
        cancelOutstandingPendingRequests(inputValue.runId, suspend)
        suspend.cancel()
        activeRuns.delete(activeRunKey)
        queue.close()
      },
    }
  }

  function respondPermission(response: Parameters<OrchestrationRunHandle["respondPermission"]>[0]) {
    const permissionRequest = input.permission.getPermissionRequest(response.requestId)
    const activeRun = activeRuns.get(
      buildActiveRunKey(permissionRequest.sessionId, permissionRequest.runId),
    )

    if (!activeRun || !activeRun.suspend.isPending(response.requestId)) {
      throwPermissionRequestNotAwaitingActiveRuntime(permissionRequest)
    }

    activeRun.suspend.respond(response)
  }

  function cancelRun(runId: string) {
    const run = input.session.getRun(runId)
    const activeRun = activeRuns.get(buildActiveRunKey(run.sessionId, runId))
    if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") {
      return false
    }

    cancelOutstandingPendingRequests(runId, activeRun?.suspend)

    if (!activeRun) {
      return stepService.cancelRun({ runId })
    }

    activeRun.controller.abort()
    activeRun.suspend.cancel()
    return true
  }

  return {
    async run(runInput: OrchestrationRunInput): Promise<OrchestrationRunHandle> {
      const execution = await createActiveRunExecution({
        sessionId: runInput.sessionId,
        runId: runInput.runId,
      })

      void runOrchestrationLoop({
        sessionId: execution.session.id,
        runId: runInput.runId,
        stepService,
        emit: execution.emit,
        afterInitialize: execution.afterInitialize,
        signal: execution.controller.signal,
        tools: execution.tools,
        workspaceRoot: execution.session.workspaceRoot,
        systemPrompt: input.systemPrompt ?? execution.defaultSystemPrompt,
      }).finally(() => {
        execution.cleanup()
      })

      return {
        events: execution.queue.stream(),
        cancel() {
          cancelRun(runInput.runId)
        },
        respondPermission(response: OrchestrationPermissionResponse) {
          respondPermission(response)
        },
      }
    },
    async compactSession(runInput: OrchestrationRunInput): Promise<OrchestrationRunHandle> {
      const execution = await createActiveRunExecution({
        sessionId: runInput.sessionId,
        runId: runInput.runId,
      })

      void (async () => {
        try {
          stepService.initializeRun({
            sessionId: execution.session.id,
            runId: runInput.runId,
            emit: execution.emit,
          })
          await execution.afterInitialize?.()
          const outcome = await stepService.compactSession({
            sessionId: execution.session.id,
            runId: runInput.runId,
            tools: execution.tools,
            workspaceRoot: execution.session.workspaceRoot,
            systemPrompt: input.systemPrompt ?? execution.defaultSystemPrompt,
            signal: execution.controller.signal,
            emit: execution.emit,
          })

          if (outcome.status === "failed") {
            stepService.failRun({
              runId: runInput.runId,
              error: outcome.error,
              emit: execution.emit,
            })
            return
          }

          if (outcome.status === "cancelled") {
            stepService.cancelRun({
              runId: runInput.runId,
              emit: execution.emit,
            })
            return
          }

          stepService.completeRun({
            runId: runInput.runId,
            emit: execution.emit,
          })
        } catch (error) {
          if (stepService.isAbortError(error, execution.controller.signal)) {
            stepService.cancelRun({
              runId: runInput.runId,
              emit: execution.emit,
            })
            return
          }

          stepService.failRun({
            runId: runInput.runId,
            error: stepService.getErrorMessage(error),
            emit: execution.emit,
          })
        }
      })().finally(() => {
        execution.cleanup()
      })

      return {
        events: execution.queue.stream(),
        cancel() {
          cancelRun(runInput.runId)
        },
        respondPermission(response: OrchestrationPermissionResponse) {
          respondPermission(response)
        },
      }
    },
    respondPermission,
    cancelRun,
    setSessionThinkingOverride(inputValue: {
      sessionId: string
      thinking: ThinkingConfig | null
    }) {
      if (inputValue.thinking === null) {
        sessionThinkingOverrides.delete(inputValue.sessionId)
        input.model.restoreThinking?.({ sessionId: inputValue.sessionId })
        return input.thinking ?? null
      }

       sessionThinkingOverrides.set(inputValue.sessionId, inputValue.thinking)

      if (inputValue.thinking.enabled === false) {
        input.model.continueWithoutThinking?.({ sessionId: inputValue.sessionId })
      } else {
        input.model.restoreThinking?.({ sessionId: inputValue.sessionId })
      }

      return inputValue.thinking
    },
  }
}

function buildDefaultSystemPrompt(input: {
  session: CreateOrchestrationRuntimeApiInput["session"]["getSession"] extends (sessionId: string) => infer T ? T : never
  now: () => number
  tools: ReturnType<OrchestrationToolPort["list"]>
}) {
  void input.session
  void input.now
  return buildStaticPromptAssembly({
    toolGuidances: deriveToolGuidanceEntries(input.tools),
  })
}

function resolvePromptAssembly(input: string | StaticPromptAssembly): StaticPromptAssembly {
  if (typeof input === "string") {
    return {
      prompt: input,
      sections: [],
      totalChars: input.length,
      hasMemorySnapshot: false,
      hasSkillReminders: false,
    }
  }

  return input
}

function resolvePromptBuildResult(input: BuildSystemPromptResult) {
  if (typeof input === "string" || "prompt" in input) {
    return {
      assembly: input,
    }
  }

  return input
}

function deriveToolGuidanceEntries(tools: ReturnType<OrchestrationToolPort["list"]>): ToolGuidanceEntry[] {
  return tools
    .filter((tool): tool is OrchestrationTool & { usageGuidance: string } => Boolean(tool.usageGuidance?.trim()))
    .map((tool) => ({
      name: tool.name,
      guidance: tool.usageGuidance,
      isReadOnly: tool.concurrency === "read-only",
    }))
}

export type OrchestrationRuntimeApi = ReturnType<typeof createOrchestrationRuntimeApi>
