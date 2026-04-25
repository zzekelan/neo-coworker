import { join } from "node:path"
import { z } from "zod"
import { getStoragePath } from "./paths"
import {
  assertRunStatusTransition,
  buildCreateSubSessionInput,
  createSessionRepository as createStorageRepository,
  createSessionRuntimeApi,
  openSessionDatabase as openStorageDatabase,
  resolvePermissionPendingRunStatus,
  type SessionDatabase,
  type SessionProvider,
  type SessionRepository as StorageRepository,
} from "../session"
import {
  createPermissionAllowlistStore,
  createPermissionRepository,
  createPermissionRuntimeApi,
  RiskLevel,
  RiskAssessmentService,
  type PermissionMode,
  type PermissionObserverPort,
  type PermissionResponse,
  type PermissionRepository,
} from "../permission"
import {
  createBuiltinToolRuntime,
  createResultStore as createToolResultStore,
  createShadowGitCheckpointStore,
  createToolProviderFromRuntime,
  createToolProvider,
  createToolRuntimeApi,
  manageResultSize,
  ParallelExecutor,
  ParallelizationClass,
  ShadowGitCheckpointError,
  shouldCheckpoint,
  TurnBudget,
  throwIfToolAborted,
  type RequestToolPermission,
  type SearchToolBackend,
  type ToolDefinition,
  type ToolParallelConfig,
} from "../tool"
import type { ModelProvider } from "../model"
import {
  createSkillWriteService,
  createLayeredSkillRuntime,
  createWorkspaceSkillStore,
  type SkillObserverPort,
  type SkillRuntimeApi,
} from "../skill"
import {
  createAgentProfileService,
  createAgentTool,
  createSubAgentRun as createAgentSubRun,
  buildToolDeniedMessage,
  isToolAllowedForAgent,
  type AgentModelPort,
  type AgentModelTurnRequest,
  type AgentProfile,
  type AgentProfileService,
} from "../agent"
import {
  createObservabilityRepository,
  createObservabilityRuntimeApi,
  type ObservabilityRepository,
  type ObservabilityRuntimeApi,
} from "../observability"
import { createMemoryRuntime } from "../memory"
import type {
  OrchestrationModelPort,
  OrchestrationPermissionPort,
  OrchestrationSessionPort,
  OrchestrationSkillPort,
  OrchestrationToolPort,
  OrchestrationToolPortFactory,
} from "../orchestration"
import {
  buildAgentAwarePrompt,
  createOrchestrationActiveRunRegistry,
  createOrchestrationRuntimeApi,
  createOrchestrationStepService,
  createOrchestrationToolBatchExecutor,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  redactDiagnosticMessage,
  resolvePermissionPolicy,
  type OrchestrationActiveRunRegistry,
  type RunHandle,
  type OrchestrationModelTurnRequest,
  PermissionRequestNotAwaitingActiveRuntimeError,
} from "../orchestration"

import { buildStaticPromptAssembly, type ToolGuidanceEntry } from "../orchestration"

type RuntimeInput = {
  provider: OrchestrationModelPort
  repository: StorageRepository
  permissionRepository: PermissionRepository
  skill?: OrchestrationSkillPort
  skillRuntime?: SkillRuntimeApi
  observability?: Pick<
    ObservabilityRuntimeApi,
    | "runtimeObserver"
    | "modelObserver"
    | "toolObserver"
    | "permissionObserver"
    | "memoryObserver"
    | "skillObserver"
  >
  searchBackend?: SearchToolBackend
  permissionPolicy?: Partial<
    Record<
      "write" | "edit" | "shell" | "webfetch" | "websearch" | "codesearch" | "plan_exit",
      PermissionMode
    >
  >
  activeRuns?: OrchestrationActiveRunRegistry
  systemPrompt?: string
  contextWindow?: number
  thinking?: OrchestrationModelTurnRequest["thinking"]
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

type CliRuntimeInput = Omit<RuntimeInput, "repository" | "permissionRepository"> & {
  createStorageRepositoryImpl?: typeof createStorageRepository
  createPermissionRepositoryImpl?: typeof createPermissionRepository
  createObservabilityRepositoryImpl?: typeof createObservabilityRepository
  openStorageDatabaseImpl?: typeof openStorageDatabase
  repository?: StorageRepository
  permissionRepository?: PermissionRepository
  observabilityRepository?: ObservabilityRepository
}

type CliRunInput = {
  prompt: string
  cwd: string
  workspaceRoot: string
}

export { PermissionRequestNotAwaitingActiveRuntimeError }

export function createOrchestrationModelPort(provider: ModelProvider): OrchestrationModelPort {
  return {
    projectTurn(request) {
      return provider.projectTurn({
        systemPrompt: request.systemPrompt,
        lateContextMessage: request.lateContextMessage,
        skillCatalog: request.skillCatalog,
        activeSkills: request.activeSkills,
        systemReminders: request.systemReminders,
        systemReminderMetadata: request.systemReminderMetadata,
        contextWindow: request.contextWindow,
        tools: request.tools,
        transcript: request.transcript,
        compressibleToolNames: request.compressibleToolNames,
        temperature: request.temperature,
      })
    },
    async *streamTurn(request) {
      for await (const event of provider.streamTurn({
        systemPrompt: request.systemPrompt,
        lateContextMessage: request.lateContextMessage,
        skillCatalog: request.skillCatalog,
        activeSkills: request.activeSkills,
        systemReminders: request.systemReminders,
        systemReminderMetadata: request.systemReminderMetadata,
        contextWindow: request.contextWindow,
        temperature: request.temperature,
        thinking: request.thinking,
        tools: request.tools,
        transcript: request.transcript,
        compressibleToolNames: request.compressibleToolNames,
        sessionId: request.sessionId,
        runId: request.runId,
        turnKey: request.turnKey,
        signal: request.signal,
      })) {
        yield event
      }
    },
    continueWithoutThinking(input) {
      provider.continueWithoutThinking?.(input)
    },
    restoreThinking(input) {
      provider.restoreThinking?.(input)
    },
  }
}

export function createRuntime(input: RuntimeInput) {
  const now = input.now ?? Date.now
  const observability = input.observability
  const subAgentModel = createAgentModelPort(input.provider)
  const permissionObserver = createPermissionObserver(observability?.permissionObserver)
  const basePermissionPolicy = resolvePermissionPolicy(input.permissionPolicy)
  const agentProfileServices = new Map<string, AgentProfileService>()
  const getAgentProfileService = (workspaceRoot: string) => {
    const cached = agentProfileServices.get(workspaceRoot)
    if (cached) {
      return cached
    }

    const service = createAgentProfileService(workspaceRoot)
    agentProfileServices.set(workspaceRoot, service)
    return service
  }
  const skillPort = input.skill ?? createSkillPort({ runtime: input.skillRuntime })
  const contextWindow = {
    getContextWindow() {
      return input.contextWindow ?? DEFAULT_CONTEXT_WINDOW_SIZE
    },
  }
  const sessionProvider = createSessionRuntimeApi({
    repository: input.repository,
    now,
  })
  const sessionPort = createSessionPort({
    repository: input.repository,
    session: sessionProvider.runs,
  })
  const permissionPort = createPermissionPort({
    repository: input.permissionRepository,
    session: createPermissionSessionPort({
      repository: input.repository,
      session: sessionProvider.runs,
      permissionRepository: input.permissionRepository,
    }),
    observer: permissionObserver,
    now,
  })

  return createOrchestrationRuntimeApi({
    model: input.provider,
    contextWindow,
    session: sessionPort,
    agentProfiles: {
      async getResolvedProfile({ workspaceRoot, name }) {
        return getAgentProfileService(workspaceRoot).getResolvedProfile(name)
      },
      async checkToolAccess({ workspaceRoot, agentName, toolName }) {
        const profile = await getAgentProfileService(workspaceRoot).getResolvedProfile(agentName)
        if (!profile || isToolAllowedForAgent(toolName, profile)) {
          return { allowed: true }
        }

        return {
          allowed: false,
          deniedMessage: buildToolDeniedMessage(toolName, agentName),
        }
      },
    },
    skill: skillPort,
    thinking: input.thinking,
    telemetry: input.telemetry,
    permission: permissionPort,
    tools: createToolPortFactory({
      permissionObserver,
      permissionPolicy: basePermissionPolicy,
      observer: observability?.toolObserver,
      repository: input.repository,
      model: input.provider,
      contextWindow,
      sessionPort,
      runtimeObserver: observability?.runtimeObserver,
      memoryObserver: observability?.memoryObserver,
      skillObserver: createSkillObserver(observability?.skillObserver),
      searchBackend: input.searchBackend,
      agentProfileService(workspaceRoot) {
        return getAgentProfileService(workspaceRoot)
      },
      async createSubAgentRun(subAgentInput) {
        return createAgentSubRun({
          ...subAgentInput,
          model: subAgentModel,
          session: sessionPort,
          skill: skillPort,
          contextWindow,
          thinking: input.thinking,
          runtimeObserver: createForwardingRuntimeObserver({
            observer: observability?.runtimeObserver,
            forwardRuntimeEvent: subAgentInput.forwardRuntimeEvent,
          }),
          toolObserver: observability?.toolObserver,
          createResultStore({ workspaceRoot, sessionId, runId }) {
            return createToolResultStore({
              workspaceRoot,
              basePath: ".ncoworker/tool-results",
              observer: observability?.toolObserver,
              sessionId,
              runId,
            })
          },
          now,
          buildAgentAwarePrompt,
          createStepService: createOrchestrationStepService,
          createToolBatchExecutor: createOrchestrationToolBatchExecutor,
          createToolRuntime: createToolRuntimeApi,
          createToolProvider: createToolProviderFromRuntime,
        })
      },
      session: sessionProvider.runs,
      skill: skillPort,
      now,
    }),
    activeRuns: input.activeRuns ?? createOrchestrationActiveRunRegistry(),
    permissionPolicy: forceAskPermissionPolicy(basePermissionPolicy),
    systemPrompt: input.systemPrompt,
    async buildSystemPrompt(promptInput) {
      const memory = createMemoryRuntime(join(promptInput.session.workspaceRoot, ".ncoworker", "memory"))
      const [agentEntries, userEntries, memorySnapshot] = await Promise.all([
        memory.load("agent"),
        memory.load("user"),
        memory.getSnapshot(),
      ])
      const assembly = buildStaticPromptAssembly({
        toolGuidances: deriveToolGuidanceEntries(promptInput.tools),
        memorySnapshot,
      })

      return {
        assembly,
        afterInitialize: () => {
          observability?.memoryObserver?.recordMemoryEvent?.({
            sessionId: promptInput.sessionId,
            runId: promptInput.runId,
            type: "memory.loaded",
            payload: {
              target: "all",
              entryCount: agentEntries.length + userEntries.length,
              snapshotLength: memorySnapshot.length,
            },
          })

          observability?.runtimeObserver?.recordRuntimeEvent?.({
            sessionId: promptInput.sessionId,
            runId: promptInput.runId,
            event: {
              type: "prompt.assembled",
              fullPromptText: assembly.prompt,
              sections: assembly.sections,
              totalChars: assembly.totalChars,
              hasMemorySnapshot: assembly.hasMemorySnapshot,
              hasSkillReminders: assembly.hasSkillReminders,
            },
            occurredAt: now(),
          })
        },
      }
    },
    now,
    runtimeObserver: observability?.runtimeObserver,
  })
}

function createAgentModelPort(model: OrchestrationModelPort): AgentModelPort {
  const agentModel: AgentModelPort = {
    async *streamTurn(request: AgentModelTurnRequest) {
      for await (const event of model.streamTurn(request)) {
        yield event
      }
    },
  }

  if (model.projectTurn) {
    const projectTurn = model.projectTurn
    agentModel.projectTurn = (request: Omit<AgentModelTurnRequest, "signal">) => projectTurn(request)
  }

  return agentModel
}

export function getDefaultCliStoragePath(workspaceRoot: string) {
  return getStoragePath(workspaceRoot)
}

export function createCliStorageComposition(input: {
  workspaceRoot: string
  now?: () => number
  createStorageRepositoryImpl?: typeof createStorageRepository
  createPermissionRepositoryImpl?: typeof createPermissionRepository
  createObservabilityRepositoryImpl?: typeof createObservabilityRepository
  openStorageDatabaseImpl?: typeof openStorageDatabase
  repository?: StorageRepository
  permissionRepository?: PermissionRepository
  observabilityRepository?: ObservabilityRepository
}) {
  const now = input.now ?? Date.now
  const database =
    input.repository == null
      ? (input.openStorageDatabaseImpl ?? openStorageDatabase)(
          getDefaultCliStoragePath(input.workspaceRoot),
        )
      : null
  if (input.repository && !input.permissionRepository) {
    throw new Error("permissionRepository is required when repository is provided")
  }
  const repository =
    input.repository ??
    (input.createStorageRepositoryImpl ?? createStorageRepository)({
      database: database!,
      now,
    })
  const permissionRepository =
    input.permissionRepository ??
    (input.createPermissionRepositoryImpl ?? createPermissionRepository)({
      database: database!,
      now,
    })
  const observabilityRepository =
    input.observabilityRepository ??
    (database
      ? (input.createObservabilityRepositoryImpl ?? createObservabilityRepository)({
          database,
          now,
        })
      : undefined)

  return {
    database,
    repository,
    permissionRepository,
    observabilityRepository,
    close() {
      database?.close(false)
    },
  } satisfies {
    database: SessionDatabase | null
    repository: StorageRepository
    permissionRepository: PermissionRepository
    observabilityRepository?: ObservabilityRepository
    close(): void
  }
}

export function createCliRuntime(input: CliRuntimeInput) {
  const now = input.now ?? Date.now

  return {
    async run(runInput: CliRunInput): Promise<RunHandle> {
      const storage = createCliStorageComposition({
        workspaceRoot: runInput.workspaceRoot,
        now,
        repository: input.repository,
        permissionRepository: input.permissionRepository,
        observabilityRepository: input.observabilityRepository,
        openStorageDatabaseImpl: input.openStorageDatabaseImpl,
        createStorageRepositoryImpl: input.createStorageRepositoryImpl,
        createPermissionRepositoryImpl: input.createPermissionRepositoryImpl,
        createObservabilityRepositoryImpl: input.createObservabilityRepositoryImpl,
      })
      const repository = storage.repository
      const permissionRepository = storage.permissionRepository
      const observability = storage.observabilityRepository
        ? createObservabilityRuntimeApi({
            repository: storage.observabilityRepository,
            now,
          })
        : undefined
      const sessionProvider = createSessionRuntimeApi({
        repository,
        now,
      })
      const runtime = createRuntime({
        ...input,
        repository,
        permissionRepository,
        observability,
        now,
      })

      try {
        const storedSession = repository.sessions.create({
          directory: runInput.cwd,
          workspaceRoot: runInput.workspaceRoot,
          createdAt: now(),
        })
        const started = sessionProvider.runs.start({
          sessionId: storedSession.id,
          trigger: "cli",
          createdAt: now(),
          messageCreatedAt: now(),
        })

        repository.parts.create({
          sessionId: storedSession.id,
          runId: started.run.id,
          messageId: started.message.id,
          kind: "text",
          sequence: 0,
          text: runInput.prompt,
          createdAt: now(),
        })

        const handle = await runtime.run({
          sessionId: storedSession.id,
          runId: started.run.id,
        })

        return input.repository ? handle : withDatabaseCleanup(handle, () => storage.close())
      } catch (error) {
        storage.close()
        throw error
      }
    },
  }
}

function createSessionPort(input: {
  repository: StorageRepository
  session: Pick<
    SessionProvider["runs"],
    "transitionToRunning" | "complete" | "fail" | "cancel" | "recordTokenUsage"
  >
}): OrchestrationSessionPort {
  return {
    storageIdentity: input.repository.storageIdentity,
    getSession(sessionId) {
      return input.repository.sessions.get(sessionId)
    },
    getRun(runId) {
      return input.repository.runs.get(runId)
    },
    listTranscript(sessionId) {
      return input.repository.messages.listSessionTranscript(sessionId)
    },
    createRun(run) {
      return input.repository.runs.create({
        id: run.id,
        sessionId: run.sessionId,
        trigger: run.trigger,
        status: run.status,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        errorText: run.errorText,
        activeSkills: run.activeSkills,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        tokenUsageSource: run.tokenUsageSource,
      })
    },
    createAssistantMessage(message) {
      const session = input.repository.sessions.get(message.sessionId)
      return input.repository.messages.create({
        sessionId: message.sessionId,
        runId: message.runId,
        agent: session.currentAgent,
        role: "assistant",
        sequence: message.sequence,
        createdAt: message.createdAt,
      })
    },
    createSyntheticMessage(message) {
      const session = input.repository.sessions.get(message.sessionId)
      return input.repository.messages.create({
        sessionId: message.sessionId,
        runId: message.runId,
        agent: session.currentAgent,
        role: "synthetic",
        sequence: message.sequence,
        createdAt: message.createdAt,
      })
    },
    createMessagePart(part) {
      return input.repository.parts.create({
        sessionId: part.sessionId,
        runId: part.runId,
        messageId: part.messageId,
        kind: part.kind as never,
        sequence: part.sequence,
        text: part.text,
        data: part.data,
        createdAt: part.createdAt,
      })
    },
    updateMessagePart(update) {
      return input.repository.parts.updateContent(update)
    },
    recordRunTokenUsage(update) {
      return input.session.recordTokenUsage(update)
    },
    transitionRunToRunning(runId) {
      return input.session.transitionToRunning(runId)
    },
    completeRun(runId) {
      return input.session.complete(runId)
    },
    failRun(run) {
      return input.session.fail(run)
    },
    cancelRun(runId) {
      return input.session.cancel(runId)
    },
  }
}

function createPermissionPort(input: {
  repository: PermissionRepository
  session: ReturnType<typeof createPermissionSessionPort>
  observer?: PermissionObserverPort
  now: () => number
}): OrchestrationPermissionPort {
  const permissionsApi = createPermissionRuntimeApi({
    repository: input.repository,
    session: input.session,
    observer: input.observer,
    now: input.now,
  })

  return {
    createCoordinator: permissionsApi.createCoordinator,
    getPermissionRequest: permissionsApi.getPermissionRequest,
    requestPermission: permissionsApi.requestPermission,
    respondPermission: permissionsApi.respondPermission,
    cancelPendingRequestsByRun: permissionsApi.cancelPendingRequestsByRun,
  }
}

function createToolPortFactory(config: {
  observer?: Pick<ObservabilityRuntimeApi, "toolObserver">["toolObserver"]
  permissionObserver?: PermissionObserverPort
  permissionPolicy: ReturnType<typeof resolvePermissionPolicy>
  repository: StorageRepository
  model: OrchestrationModelPort
  contextWindow: { getContextWindow(): number }
  sessionPort: OrchestrationSessionPort
  runtimeObserver?: Pick<ObservabilityRuntimeApi, "runtimeObserver">["runtimeObserver"]
  memoryObserver?: Pick<ObservabilityRuntimeApi, "memoryObserver">["memoryObserver"]
  skillObserver?: SkillObserverPort
  searchBackend?: SearchToolBackend
  agentProfileService: (workspaceRoot: string) => AgentProfileService
  createSubAgentRun: (input: {
    profile: AgentProfile
    prompt: string
    sessionId: string
    parentRunId: string
    workspaceRoot: string
    parentTools: OrchestrationToolPort
    signal?: AbortSignal
    forwardRuntimeEvent?(event: { type: string; [key: string]: unknown }): void
    resolveThinking?: (sessionId: string) => OrchestrationModelTurnRequest["thinking"] | undefined
    createQueuedRun(input: {
      subRunId: string
      sessionId: string
      prompt: string
      activeSkills: string[]
      createdAt: number
      parentRunId: string
    }): { subSessionId: string }
  }) => Promise<string>
  session: Pick<SessionProvider["runs"], "addActiveSkills">
  skill: OrchestrationSkillPort
  now: () => number
}): OrchestrationToolPortFactory {
  const batchExecutor = createOrchestrationToolBatchExecutor()

  return {
    create(input) {
      const workspaceRoot = config.repository.sessions.get(input.sessionId).workspaceRoot
      const agentProfileService = config.agentProfileService(workspaceRoot)
      const riskService = new RiskAssessmentService(undefined, config.permissionObserver)
      const allowlist = createPermissionAllowlistLookup({
        storageIdentity: config.repository.storageIdentity,
        workspaceRoot,
        now: config.now,
        observer: config.permissionObserver,
        sessionId: input.sessionId,
        runId: input.runId,
      })
      const requestPermission = createAllowlistAwarePermission(
        createRiskAwarePermission(input.requestPermission, riskService, {
          permissionPolicy: config.permissionPolicy,
          sessionId: input.sessionId,
          runId: input.runId,
        }),
        allowlist,
        riskService,
        {
          permissionPolicy: config.permissionPolicy,
          sessionId: input.sessionId,
          runId: input.runId,
        },
      )
      const runtimeObserver = createForwardingRuntimeObserver({
        observer: config.runtimeObserver,
        forwardRuntimeEvent: input.forwardRuntimeEvent,
      })
      const memory = createMemoryRuntime(join(workspaceRoot, ".ncoworker", "memory"), {
        memoryObserver: createMemoryObserver(config.memoryObserver),
        observerContext: {
          sessionId: input.sessionId,
          runId: input.runId,
        },
      })
      const resultStore = createToolResultStore({
        workspaceRoot,
        basePath: ".ncoworker/tool-results",
        observer: config.observer,
        sessionId: input.sessionId,
        runId: input.runId,
      })
      const checkpointStore = createShadowGitCheckpointStore({
        observer: config.observer,
        observerContext: {
          sessionId: input.sessionId,
          runId: input.runId,
        },
      })
      let runtime!: ReturnType<typeof createBuiltinToolRuntime>
      runtime = createBuiltinToolRuntime({
        requestPermission(request) {
          return requestPermission(request)
        },
        searchBackend: config.searchBackend,
        memory,
        observer: config.observer,
        observerContext: {
          sessionId: input.sessionId,
          runId: input.runId,
        },
        extraTools: [
          createSkillTool({
            repository: config.repository,
            runtimeObserver,
            session: config.session,
            skill: config.skill,
            sessionId: input.sessionId,
            runId: input.runId,
            now: config.now,
          }),
          createPlanExitTool({
            repository: config.repository,
            requestPermission,
            sessionId: input.sessionId,
          }),
          ...createSkillWriteTools({
            requestPermission(request) {
              return requestPermission(request)
            },
            skillObserver: config.skillObserver,
            sessionId: input.sessionId,
            runId: input.runId,
          }),
          createAgentTool({
            sessionId: input.sessionId,
            runId: input.runId,
            agentProfileService,
            createSubAgentRun(profile, prompt, signal) {
              return config.createSubAgentRun({
                profile,
                prompt,
                sessionId: input.sessionId,
                parentRunId: input.runId,
                workspaceRoot,
                resolveThinking: input.resolveThinking,
                forwardRuntimeEvent: input.forwardRuntimeEvent,
                parentTools: {
                  ...createToolProviderFromRuntime({ runtime }),
                  async executeBatch(batchInput) {
                    const results = await executeParallelizedBatch({
                      calls: batchInput.calls,
                      workspaceRoot: batchInput.workspaceRoot,
                      signal: batchInput.signal,
                      tools: {
                        execute: createToolProviderFromRuntime({ runtime }).execute,
                      },
                    })

                    return applyTurnBudget(results, results.map(manageBatchResult))
                  },
                },
                signal,
                createQueuedRun({ subRunId, sessionId, prompt, createdAt, parentRunId }) {
                  const parentSession = config.repository.sessions.get(sessionId)
                  const subSession = buildCreateSubSessionInput({
                    parentSession,
                    prompt,
                    trigger: "prompt",
                    skills:
                      profile.skills?.some((skill) => skill.trim().length > 0) ? profile.skills : undefined,
                  })
                  const result = config.repository.createSubSessionWithRun({
                    session: subSession,
                    run: {
                      id: subRunId,
                      trigger: "prompt",
                      createdAt,
                      activeSkills: subSession.activeSkills,
                      parentRunId,
                    },
                    message: {
                      sequence: 0,
                      createdAt,
                    },
                    part: {
                      kind: "text",
                      sequence: 0,
                      text: prompt,
                      createdAt,
                    },
                  })

                  return { subSessionId: result.session.id }
                },
              })
            },
            currentDepth: 0,
          }),
        ],
      })

      function manageBatchResult<
        T extends {
          callId?: string
          toolName: string
          output: string
          isError?: boolean
          metadata?: Record<string, unknown>
        },
      >(result: T): T {
        const tool = runtime.list().find((candidate) => candidate.name === result.toolName)

        return {
          ...result,
          ...manageResultSize(
            {
              output: result.output,
              isError: result.isError,
              metadata: result.metadata,
            },
            {
              tool,
              toolName: result.toolName,
              workspaceRoot,
              observer: config.observer,
              sessionId: input.sessionId,
              runId: input.runId,
              resultStore,
            },
          ),
        } satisfies T
      }

      async function executeWithCheckpoint(value: {
        toolName: string
        args: unknown
        workspaceRoot: string
        signal?: AbortSignal
        onProgress?: (message: string) => void
      }) {
        if (shouldCheckpoint(value.toolName, asCheckpointArgs(value.args))) {
          try {
            await checkpointStore.create(
              value.workspaceRoot,
              buildCheckpointDescription(value.toolName, value.args),
            )
          } catch (error) {
            if (!(error instanceof ShadowGitCheckpointError)) {
              throw error
            }
          }
        }

        return provider.execute(value)
      }

      async function executeParallelizedBatch(batchInput: {
        calls: Array<{
          callId: string
          toolName: string
          args: unknown
          onProgress?: (message: string) => void
        }>
        workspaceRoot: string
        signal: AbortSignal
        tools: Pick<ReturnType<typeof createToolProvider>, "execute">
      }) {
        if (batchInput.calls.length <= 1) {
          return batchExecutor.execute({
            calls: batchInput.calls,
            tools: batchInput.tools,
            availableTools: runtime.list(),
            workspaceRoot: batchInput.workspaceRoot,
            signal: batchInput.signal,
          })
        }

        const orderedResults = new Map<string, Awaited<ReturnType<typeof batchExecutor.execute>>[number]>()
        const availableTools = runtime.list()
        const parallelExecutor = new ParallelExecutor(buildParallelExecutorConfig(availableTools, batchInput.calls), {
          observer: config.observer,
          observerContext: {
            sessionId: input.sessionId,
            runId: input.runId,
          },
          now: config.now,
        })

        await parallelExecutor.schedule(
          batchInput.calls.map((call) => ({
            name: call.toolName,
            args: toParallelExecutorArgs(call.callId, call.args),
          })),
          async (plannedBatch) => {
            const plannedCalls = plannedBatch.map((plannedCall) => {
              const callId = readParallelExecutorCallId(plannedCall.args)
              const nextCall = batchInput.calls.find((call) => call.callId === callId)

              if (!nextCall) {
                throw new Error(`Missing tool call for planned batch entry ${plannedCall.name}`)
              }

              return nextCall
            })

            const batchResults = await batchExecutor.execute({
              calls: plannedCalls,
              tools: batchInput.tools,
              availableTools,
              workspaceRoot: batchInput.workspaceRoot,
              signal: batchInput.signal,
            })

            for (const result of batchResults) {
              orderedResults.set(result.callId, result)
            }

            return undefined
          },
        )

        return batchInput.calls.map((call) => {
          const result = orderedResults.get(call.callId)
          if (!result) {
            throw new Error(`Missing tool result for call ${call.callId}`)
          }

          return result
        })
      }

      function applyTurnBudget<T extends {
        toolName: string
        output: string
        isError?: boolean
        metadata?: Record<string, unknown>
      }>(rawResults: T[], managedResults: T[]): T[] {
        const turnBudget = new TurnBudget({
          observer: config.observer,
          observerContext: {
            sessionId: input.sessionId,
            runId: input.runId,
          },
        })

        for (const result of rawResults) {
          if (result.isError) {
            continue
          }

          turnBudget.track(result.toolName, result.output)
        }

        if (!turnBudget.isOverBudget()) {
          return managedResults
        }

        const spilledResults = turnBudget.spillLargest(resultStore)
        if (spilledResults.length === 0) {
          return managedResults
        }

        const spilledByPosition = new Map(spilledResults.map((entry) => [entry.position, entry]))

        return managedResults.map((result, index) => {
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
      }

      const provider = createToolProvider({
        runtime,
        observer: config.observer,
        scope: {
          sessionId: input.sessionId,
          runId: input.runId,
        },
      })

      return {
        ...provider,
        listCatalog() {
          return runtime.list()
        },
        async execute(executeInput) {
          return executeWithCheckpoint(executeInput)
        },
        async executeBatch(batchInput) {
          const results = await executeParallelizedBatch({
            calls: batchInput.calls,
            workspaceRoot: batchInput.workspaceRoot,
            signal: batchInput.signal,
            tools: {
              execute: executeWithCheckpoint,
            },
          })

          return applyTurnBudget(results, results.map(manageBatchResult))
        },
      }
    },
  }
}

function toParallelExecutorArgs(callId: string, args: unknown): Record<string, unknown> {
  return {
    ...((args && typeof args === "object" ? args : {}) as Record<string, unknown>),
    __parallelExecutorCallId: callId,
  }
}

function readParallelExecutorCallId(args: unknown) {
  const callId = (args as { __parallelExecutorCallId?: unknown } | null | undefined)?.__parallelExecutorCallId
  if (typeof callId !== "string" || callId.length === 0) {
    throw new Error("Parallel executor batch entry missing call id")
  }

  return callId
}

function buildParallelExecutorConfig(
  availableTools: Array<{
    name: string
    concurrency?: "read-only" | "mutating"
    isConcurrencySafe?: (input: unknown) => boolean
  }>,
  calls: Array<{
    toolName: string
    args: unknown
  }>,
) {
  const toolsByName = new Map(availableTools.map((tool) => [tool.name, tool]))
  const config = new Map<string, ToolParallelConfig>()

  for (const call of calls) {
    const tool = toolsByName.get(call.toolName)
    if (!tool) {
      continue
    }

    const nextClassification = resolveParallelizationClass(tool, call.args)
    const previous = config.get(call.toolName)?.classification
    config.set(call.toolName, {
      classification:
        previous === undefined
          ? nextClassification
          : mergeParallelizationClasses(previous, nextClassification),
    })
  }

  return config

  function resolveParallelizationClass(
    tool: {
      name: string
      concurrency?: "read-only" | "mutating"
      isConcurrencySafe?: (input: unknown) => boolean
    },
    args: unknown,
  ): ParallelizationClass {
    if (tool.isConcurrencySafe) {
      try {
        return tool.isConcurrencySafe(args)
          ? ParallelizationClass.PARALLEL_SAFE
          : ParallelizationClass.NEVER_PARALLEL
      } catch {
        return ParallelizationClass.NEVER_PARALLEL
      }
    }

    if (tool.name === "write" || tool.name === "edit") {
      return ParallelizationClass.PATH_SCOPED
    }

    return tool.concurrency === "read-only"
      ? ParallelizationClass.PARALLEL_SAFE
      : ParallelizationClass.NEVER_PARALLEL
  }
}

function mergeParallelizationClasses(
  left: ParallelizationClass,
  right: ParallelizationClass,
): ParallelizationClass {
  if (left === right) {
    return left
  }

  if (left === ParallelizationClass.NEVER_PARALLEL || right === ParallelizationClass.NEVER_PARALLEL) {
    return ParallelizationClass.NEVER_PARALLEL
  }

  if (left === ParallelizationClass.PATH_SCOPED || right === ParallelizationClass.PATH_SCOPED) {
    return ParallelizationClass.PATH_SCOPED
  }

  return ParallelizationClass.PARALLEL_SAFE
}

function asCheckpointArgs(args: unknown) {
  return args && typeof args === "object" ? args as Record<string, unknown> : {}
}

function buildCheckpointDescription(toolName: string, args: unknown) {
  switch (toolName) {
    case "write": {
      const path = typeof (args as { path?: unknown })?.path === "string"
        ? (args as { path: string }).path
        : "file"
      return `before write ${path}`
    }
    case "edit": {
      const path = typeof (args as { path?: unknown })?.path === "string"
        ? (args as { path: string }).path
        : "file"
      return `before edit ${path}`
    }
    case "patch":
      return "before patch"
    case "shell": {
      const command = typeof (args as { command?: unknown })?.command === "string"
        ? (args as { command: string }).command.trim()
        : "shell command"
      return `before shell ${command.slice(0, 120)}`
    }
    default:
      return `before ${toolName}`
  }
}

function createPermissionObserver(
  observer: Pick<ObservabilityRuntimeApi, "permissionObserver">["permissionObserver"] | undefined,
): PermissionObserverPort | undefined {
  if (!observer) {
    return undefined
  }

  return {
    recordPermissionEvent(event) {
      if (!("sessionId" in event) || !("runId" in event)) {
        return
      }

      observer.recordPermissionEvent({
        ...event,
        sessionId: event.sessionId,
        runId: event.runId,
      })
    },
  }
}

function createForwardingRuntimeObserver(input: {
  observer?: Pick<ObservabilityRuntimeApi, "runtimeObserver">["runtimeObserver"]
  forwardRuntimeEvent?(event: { type: string; [key: string]: unknown }): void
}) {
  if (!input.observer && !input.forwardRuntimeEvent) {
    return undefined
  }

  return {
    recordRuntimeEvent(eventInput: {
      sessionId: string
      runId: string
      event: { type: string; [key: string]: unknown }
      occurredAt?: number
    }) {
      try {
        input.observer?.recordRuntimeEvent?.(eventInput)
      } catch {
        // Runtime telemetry must not affect tool execution.
      }

      if (!isLifecycleRuntimeEvent(eventInput.event.type)) {
        return
      }

      try {
        input.forwardRuntimeEvent?.({
          ...eventInput.event,
          sessionId: eventInput.sessionId,
          runId: eventInput.runId,
        })
      } catch {
        // Live event forwarding is best-effort and must not alter runtime behavior.
      }
    },
  }
}

function isLifecycleRuntimeEvent(type: string) {
  return type === "subagent.started" ||
    type === "subagent.completed" ||
    type === "subagent.failed" ||
    type === "skill.load.requested" ||
    type === "skill.load.completed" ||
    type === "skill.load.failed"
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function createSkillObserver(
  observer: Pick<ObservabilityRuntimeApi, "skillObserver">["skillObserver"] | undefined,
): SkillObserverPort | undefined {
  if (!observer) {
    return undefined
  }

  return {
    recordSkillEvent(event) {
      observer.recordSkillEvent(event)
    },
  }
}

function createMemoryObserver(
  observer: Pick<ObservabilityRuntimeApi, "memoryObserver">["memoryObserver"] | undefined,
) {
  if (!observer) {
    return undefined
  }

  return {
    recordMemoryEvent(event: Parameters<typeof observer.recordMemoryEvent>[0]) {
      observer.recordMemoryEvent(event)
    },
  }
}

function deriveToolGuidanceEntries(tools: ReturnType<OrchestrationToolPort["list"]>): ToolGuidanceEntry[] {
  return tools.flatMap((tool) => {
    const guidance = tool.usageGuidance?.trim()

    if (!guidance) {
      return []
    }

    return [{
      name: tool.name,
      guidance,
      isReadOnly: tool.concurrency === "read-only",
    } satisfies ToolGuidanceEntry]
  })
}

type PermissionDecoratorContext = {
  sessionId: string
  runId: string
  permissionPolicy: ReturnType<typeof resolvePermissionPolicy>
}

type PermissionAllowlistLookup = {
  isAllowed(request: { toolName: string; reason: string }): Promise<boolean>
}

function forceAskPermissionPolicy(policy: ReturnType<typeof resolvePermissionPolicy>) {
  return Object.fromEntries(
    Object.keys(policy).map((toolName) => [toolName, "ask"]),
  ) as ReturnType<typeof resolvePermissionPolicy>
}

function createRiskAwarePermission(
  inner: RequestToolPermission,
  riskService: RiskAssessmentService,
  context: PermissionDecoratorContext,
): RequestToolPermission {
  return async (request) => {
    const resolvedMode = riskService.resolveModeForRequest({
      request,
      originalMode: context.permissionPolicy[request.toolName as keyof typeof context.permissionPolicy] ?? "deny",
      sessionId: context.sessionId,
      runId: context.runId,
    })

    if (resolvedMode === "deny") {
      return {
        requestId: "permission_auto",
        decision: "deny",
      }
    }

    if (resolvedMode === "allow") {
      return {
        requestId: "permission_auto",
        decision: "allow",
      }
    }

    return inner(request)
  }
}

function createAllowlistAwarePermission(
  inner: RequestToolPermission,
  allowlist: PermissionAllowlistLookup,
  riskService: RiskAssessmentService,
  context: PermissionDecoratorContext,
): RequestToolPermission {
  return async (request) => {
    const mode = context.permissionPolicy[request.toolName as keyof typeof context.permissionPolicy] ?? "deny"
    if (mode === "deny") {
      return {
        requestId: "permission_auto",
        decision: "deny",
      }
    }

    const assessment = riskService.assessFromPermissionRequest(request, {
      sessionId: context.sessionId,
      runId: context.runId,
    })
    if (assessment.level !== RiskLevel.SAFE) {
      return inner(request)
    }

    if (mode === "ask" && await allowlist.isAllowed(request)) {
      return {
        requestId: "permission_auto",
        decision: "allow",
      }
    }

    return inner(request)
  }
}

function createPermissionAllowlistLookup(input: {
  storageIdentity: string
  workspaceRoot: string
  now: () => number
  observer?: PermissionObserverPort
  sessionId: string
  runId: string
}): PermissionAllowlistLookup {
  if (input.storageIdentity.startsWith("memory:")) {
    return {
      async isAllowed() {
        return false
      },
    }
  }

  return {
    async isAllowed(request) {
      const database = openStorageDatabase(input.storageIdentity)

      try {
        const store = createPermissionAllowlistStore({
          database,
          workspaceRoot: input.workspaceRoot,
          now: input.now,
          observer: input.observer
            ? {
                recordPermissionEvent(event) {
                  input.observer?.recordPermissionEvent?.({
                    ...event,
                    sessionId: input.sessionId,
                    runId: input.runId,
                  } as PermissionObserverPort extends { recordPermissionEvent(event: infer T): void } ? T : never)
                },
              }
            : undefined,
        })

        return await store.isAllowed(request)
      } finally {
        database.close(false)
      }
    },
  }
}

const SkillToolArgsSchema = z.object({
  action: z.enum(["activate", "list"]).optional(),
  name: z.string().trim().min(1).optional(),
}).superRefine((value, ctx) => {
  const action = value.action ?? (value.name ? "activate" : null)

  if (action === "activate" && !value.name) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: "name is required when activating a skill",
    })
  }
})

const SkillCategorySchema = z.string().trim().min(1).optional().describe(
  "Optional skill category segment. Use lowercase filesystem-safe names such as `quality` when you want the skill stored under a category directory.",
)

const SkillNameSchema = z.string().trim().min(1).describe(
  "Skill name segment. Use the intended lowercase skill identifier without file extensions or path separators, for example `reviewer`.",
)

const SkillFrontmatterSchema = z.record(z.unknown()).describe(
  "Skill frontmatter record. It must include a non-empty `description` string. Additional metadata keys are allowed and will be preserved in sorted order.",
)

const CreateSkillToolArgsSchema = z.object({
  category: SkillCategorySchema,
  name: SkillNameSchema,
  frontmatter: SkillFrontmatterSchema,
  content: z.string().describe(
    "Instruction body for the skill. Pass the full skill content without YAML frontmatter; the runtime derives and writes the document wrapper for you.",
  ),
}).describe(
  "Create a workspace skill stored under `.ncoworker/skills`. Use this to add a new reusable skill with YAML frontmatter and instruction content. Skill content is security-scanned before it is persisted.",
)

const PatchSkillToolArgsSchema = z.object({
  category: SkillCategorySchema,
  name: SkillNameSchema,
  patch: z.string().describe(
    "Replacement instruction body for the existing skill. The current frontmatter is preserved while the body is replaced. Skill content is security-scanned before it is persisted.",
  ),
}).describe(
  "Replace the instruction body of an existing workspace skill while preserving its frontmatter. Use this when you want to update guidance without rewriting metadata. Patched content is security-scanned before it is persisted.",
)

const DeleteSkillToolArgsSchema = z.object({
  category: SkillCategorySchema,
  name: SkillNameSchema,
}).describe(
  "Delete an existing workspace skill by category/name. Use this to remove a skill directory after you have confirmed it is no longer needed.",
)

const PlanExitToolArgsSchema = z.object({
  reason: z.string().trim().min(1).optional().describe(
    "Optional reason for exiting plan mode and returning to the general agent.",
  ),
}).describe(
  "Exit plan mode and return to general mode. Use this when planning is complete and the main agent should switch back to general.",
)

function createSkillTool(input: {
  repository: StorageRepository
  runtimeObserver?: ReturnType<typeof createForwardingRuntimeObserver>
  session: Pick<SessionProvider["runs"], "addActiveSkills">
  skill: OrchestrationSkillPort
  sessionId: string
  runId: string
  now: () => number
}): ToolDefinition {
  return {
    name: "skill",
    description: "List available skills or activate one by name for the current session",
    inputSchema: SkillToolArgsSchema,
    async execute(toolInput) {
      throwIfToolAborted(toolInput.signal)
      const parsed = SkillToolArgsSchema.parse(toolInput.args)
      const action = parsed.action ?? (parsed.name ? "activate" : "list")

      if (action === "list") {
        const catalog = await input.skill.listCatalog(toolInput.workspaceRoot)

        return {
          output:
            catalog.length === 0
              ? "No skills available."
              : ["Available skills:", ...catalog.map((skill) => `- ${formatSkillCatalogEntry(skill)}`)].join(
                  "\n",
                ),
        }
      }

      const { name } = parsed
      input.runtimeObserver?.recordRuntimeEvent?.({
        sessionId: input.sessionId,
        runId: input.runId,
        event: {
          type: "skill.load.requested",
          skillName: name!,
          status: "requested",
          reason: "activation",
        },
        occurredAt: input.now(),
      })
      let loaded
      try {
        loaded = await input.skill.loadSkill({
          workspaceRoot: toolInput.workspaceRoot,
          name: name!,
        })
      } catch (error) {
        const errorMessage = redactDiagnosticMessage(getErrorMessage(error))
        input.runtimeObserver?.recordRuntimeEvent?.({
          sessionId: input.sessionId,
          runId: input.runId,
          event: {
            type: "skill.load.failed",
            skillName: name!,
            status: "failed",
            reason: "activation",
            errorCode: "SKILL_LOAD_FAILED",
            errorMessage,
            error: errorMessage,
          },
          occurredAt: input.now(),
        })
        throw error
      }
      throwIfToolAborted(toolInput.signal)
      input.runtimeObserver?.recordRuntimeEvent?.({
        sessionId: input.sessionId,
        runId: input.runId,
        event: {
          type: "skill.load.completed",
          skillName: loaded.name,
          skillPath: loaded.path,
          status: "completed",
          instructionsLength: loaded.instructions.length,
          reason: "activation",
        },
        occurredAt: input.now(),
      })
      const run = input.repository.runs.get(input.runId)

      if (run.sessionId !== input.sessionId) {
        throw new Error(`Run ${input.runId} does not belong to session ${input.sessionId}`)
      }

      if (run.activeSkills.includes(loaded.name)) {
        return {
          output: `Skill ${loaded.name} is already active`,
        }
      }

      throwIfToolAborted(toolInput.signal)
      const session = input.repository.sessions.get(input.sessionId)
      input.repository.sessions.update({
        sessionId: session.id,
        activeSkills: [...session.activeSkills, loaded.name],
      })
      const updatedRun = input.session.addActiveSkills({
        runId: run.id,
        activeSkills: [...run.activeSkills, loaded.name],
      })
      input.runtimeObserver?.recordRuntimeEvent?.({
        sessionId: input.sessionId,
        runId: input.runId,
        event: {
          type: "skill.activated",
          skillName: loaded.name,
          activeSkillNames: updatedRun.activeSkills,
          activeSkillCount: updatedRun.activeSkills.length,
        },
        occurredAt: input.now(),
      })

      return {
        output: `Activated skill ${loaded.name}`,
      }
    },
  }
}

function createSkillWriteTools(input: {
  requestPermission: RequestToolPermission
  skillObserver?: SkillObserverPort
  sessionId: string
  runId: string
}): ToolDefinition[] {
  const writeService = createSkillWriteService({
    store: createWorkspaceSkillStore(),
    skillObserver: input.skillObserver,
    observerContext: {
      sessionId: input.sessionId,
      runId: input.runId,
    },
  })

  return [
    {
      name: "create_skill",
      description:
        "Create a new workspace skill under `.ncoworker/skills` with YAML frontmatter and instruction content. Use this for reusable project-specific guidance. Skill content is security-scanned before it is persisted.",
      inputSchema: CreateSkillToolArgsSchema,
      concurrency: "mutating",
      isCompressible: false,
      usageGuidance:
        "Use this only when a reusable skill should persist beyond the current run. Provide a concise `description` in frontmatter and pass only the instruction body in `content`.",
      async execute(toolInput) {
        throwIfToolAborted(toolInput.signal)
        const parsed = CreateSkillToolArgsSchema.parse(toolInput.args)
        await requestSkillWritePermission({
          requestPermission: input.requestPermission,
          category: parsed.category,
          name: parsed.name,
        })
        throwIfToolAborted(toolInput.signal)
        await writeService.createSkill({
          workspaceRoot: toolInput.workspaceRoot,
          category: parsed.category,
          name: parsed.name,
          content: parsed.content,
          frontmatter: parsed.frontmatter,
        })

        return {
          output: `Created skill ${formatSkillIdentifier(parsed.category, parsed.name)}.`,
          metadata: {
            operation: "create",
            category: parsed.category ?? null,
            name: parsed.name,
          },
        }
      },
    },
    {
      name: "patch_skill",
      description:
        "Replace the instruction body of an existing workspace skill while preserving its frontmatter. Use this to update reusable guidance. Patched content is security-scanned before it is persisted.",
      inputSchema: PatchSkillToolArgsSchema,
      concurrency: "mutating",
      isCompressible: false,
      usageGuidance:
        "Use this after confirming the skill already exists. Pass the full new body in `patch`; frontmatter stays intact and the updated content is security-scanned before write.",
      async execute(toolInput) {
        throwIfToolAborted(toolInput.signal)
        const parsed = PatchSkillToolArgsSchema.parse(toolInput.args)
        await requestSkillWritePermission({
          requestPermission: input.requestPermission,
          category: parsed.category,
          name: parsed.name,
        })
        throwIfToolAborted(toolInput.signal)
        await writeService.patchSkill({
          workspaceRoot: toolInput.workspaceRoot,
          category: parsed.category,
          name: parsed.name,
          patch: parsed.patch,
        })

        return {
          output: `Patched skill ${formatSkillIdentifier(parsed.category, parsed.name)}.`,
          metadata: {
            operation: "patch",
            category: parsed.category ?? null,
            name: parsed.name,
          },
        }
      },
    },
    {
      name: "delete_skill",
      description:
        "Delete an existing workspace skill directory. Use this when a reusable skill should be removed from the workspace catalog.",
      inputSchema: DeleteSkillToolArgsSchema,
      concurrency: "mutating",
      isCompressible: false,
      usageGuidance:
        "Only delete a skill after confirming it is no longer needed. Pass the exact category/name pair for categorized skills.",
      async execute(toolInput) {
        throwIfToolAborted(toolInput.signal)
        const parsed = DeleteSkillToolArgsSchema.parse(toolInput.args)
        await requestSkillWritePermission({
          requestPermission: input.requestPermission,
          category: parsed.category,
          name: parsed.name,
        })
        throwIfToolAborted(toolInput.signal)
        await writeService.deleteSkill({
          workspaceRoot: toolInput.workspaceRoot,
          category: parsed.category,
          name: parsed.name,
        })

        return {
          output: `Deleted skill ${formatSkillIdentifier(parsed.category, parsed.name)}.`,
          metadata: {
            operation: "delete",
            category: parsed.category ?? null,
            name: parsed.name,
          },
        }
      },
    },
  ]
}

function createPlanExitTool(input: {
  repository: StorageRepository
  requestPermission: RequestToolPermission
  sessionId: string
}): ToolDefinition {
  return {
    name: "plan_exit",
    description:
      "Exit plan mode and return to general mode. Use this when you've completed planning and the user should switch back to the general agent.",
    inputSchema: PlanExitToolArgsSchema,
    concurrency: "mutating",
    isCompressible: false,
    usageGuidance:
      "Use this only when the current session is in plan mode and planning is complete. It requires user approval before switching back to the general agent.",
    async execute(toolInput) {
      throwIfToolAborted(toolInput.signal)
      const parsed = PlanExitToolArgsSchema.parse(toolInput.args)
      const currentAgent = input.repository.sessions.getCurrentAgent(input.sessionId)

      if (currentAgent !== "plan") {
        return {
          output: "Not in plan mode.",
          isError: true,
        }
      }

      const decision = await input.requestPermission({
        toolName: "plan_exit",
        reason: parsed.reason ? `exit plan mode: ${parsed.reason}` : "exit plan mode",
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      input.repository.sessions.setCurrentAgent(input.sessionId, "general")

      return {
        output: "Switched back to general mode.",
        metadata: {
          fromAgent: "plan",
          toAgent: "general",
          reason: parsed.reason ?? null,
        },
      }
    },
  }
}

async function requestSkillWritePermission(input: {
  requestPermission: RequestToolPermission
  category?: string
  name: string
}) {
  const decision = await input.requestPermission({
    toolName: "write",
    reason: `write skill ${formatSkillIdentifier(input.category, input.name)}`,
  })

  if (decision.decision !== "allow") {
    throw createToolPermissionDeniedError()
  }
}

function formatSkillIdentifier(category: string | undefined, name: string) {
  return category ? `${category}/${name}` : name
}

function formatSkillCatalogEntry(skill: {
  name: string
  description: string
  source?: "builtin" | "global" | "workspace"
  overrides?: Array<{ source: "builtin" | "global" | "workspace"; path: string }>
}) {
  const metadata = [
    skill.source ? `source: ${skill.source}` : null,
    skill.overrides && skill.overrides.length > 0
      ? `overrides: ${skill.overrides.map((entry) => `${entry.source} ${entry.path}`).join(", ")}`
      : null,
  ].filter((entry): entry is string => entry !== null)

  return metadata.length > 0
    ? `${skill.name}: ${skill.description} [${metadata.join("; ")}]`
    : `${skill.name}: ${skill.description}`
}

function createToolPermissionDeniedError() {
  const error = new Error("Permission denied")
  error.name = "ToolPermissionDeniedError"
  return error
}

function createSkillPort(input: {
  runtime?: SkillRuntimeApi
}): OrchestrationSkillPort {
  const runtime = input.runtime ?? createLayeredSkillRuntime()

  return {
    listCatalog(workspaceRoot) {
      return runtime.listCatalog(workspaceRoot)
    },
    async loadSkill(inputValue) {
      const skill = await runtime.loadSkill(inputValue)

      return {
        name: skill.name,
        path: skill.path,
        instructions: skill.instructions,
        entryPath: skill.entryPath,
        baseDir: skill.baseDir,
        source: skill.source,
        files: skill.files,
      }
    },
  }
}

function createPermissionSessionPort(input: {
  repository: StorageRepository
  session: Pick<SessionProvider["runs"], "transitionToRunning">
  permissionRepository: PermissionRepository
}) {
  return {
    getRun(runId: string) {
      return input.repository.runs.get(runId)
    },
    syncRunStatusWithPendingRequests(runId: string) {
      const run = input.repository.runs.get(runId)
      const nextStatus = resolvePermissionPendingRunStatus(
        input.permissionRepository.requests.listByRun(runId).filter((request) => request.status === "pending").length,
      )
      if (run.status === nextStatus) {
        return run
      }

      if (nextStatus === "waiting_permission") {
        assertRunStatusTransition(run, nextStatus)
        return input.repository.runs.updateStatus({
          runId,
          status: nextStatus,
        })
      }

      return input.session.transitionToRunning(runId)
    },
  }
}

function withDatabaseCleanup(handle: RunHandle, cleanup: () => void): RunHandle {
  let cleaned = false

  function close() {
    if (cleaned) {
      return
    }

    cleaned = true
    cleanup()
  }

  return {
    events: (async function* () {
      try {
        for await (const event of handle.events) {
          yield event
        }
      } finally {
        close()
      }
    })(),
    cancel() {
      handle.cancel()
    },
    respondPermission(response: PermissionResponse) {
      handle.respondPermission(response)
    },
  }
}
