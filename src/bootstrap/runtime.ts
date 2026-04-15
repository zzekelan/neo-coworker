import { z } from "zod"
import { getStoragePath } from "./paths"
import {
  assertRunStatusTransition,
  buildCreateSubSessionInput,
  createSessionRepository as createStorageRepository,
  createSessionRuntimeApi,
  openSessionDatabase as openStorageDatabase,
  type SessionProvider,
  type SessionRepository as StorageRepository,
} from "../session"
import {
  createPermissionRepository,
  createPermissionRuntimeApi,
  type PermissionMode,
  type PermissionObserverPort,
  type PermissionResponse,
  type PermissionRepository,
} from "../permission"
import {
  createBuiltinToolRuntime,
  createToolProviderFromRuntime,
  createToolProvider,
  createToolRuntimeApi,
  manageResultSize,
  throwIfToolAborted,
  type RequestToolPermission,
  type SearchToolBackend,
  type ToolDefinition,
} from "../tool"
import {
  createSkillWriteService,
  createWorkspaceSkillStore,
  createWorkspaceSkillRuntime,
  type SkillObserverPort,
  type SkillRuntimeApi,
} from "../skill"
import {
  createAgentProfileService,
  createAgentTool,
  createSubAgentRun as createAgentSubRun,
  type AgentProfile,
  type AgentProfileService,
} from "../agent"
import {
  createObservabilityRepository,
  createObservabilityRuntimeApi,
  type ObservabilityRepository,
  type ObservabilityRuntimeApi,
} from "../observability"
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
  resolvePermissionPolicy,
  type OrchestrationActiveRunRegistry,
  type RunHandle,
  PermissionRequestNotAwaitingActiveRuntimeError,
} from "../orchestration"

type RuntimeInput = {
  provider: OrchestrationModelPort
  repository: StorageRepository
  permissionRepository: PermissionRepository
  skill?: OrchestrationSkillPort
  skillRuntime?: SkillRuntimeApi
  observability?: Pick<
    ObservabilityRuntimeApi,
    "runtimeObserver" | "modelObserver" | "toolObserver" | "permissionObserver" | "skillObserver"
  >
  searchBackend?: SearchToolBackend
  permissionPolicy?: Partial<
    Record<
      "write" | "edit" | "shell" | "webfetch" | "websearch" | "codesearch",
      PermissionMode
    >
  >
  activeRuns?: OrchestrationActiveRunRegistry
  systemPrompt?: string
  contextWindow?: number
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

export function createRuntime(input: RuntimeInput) {
  const now = input.now ?? Date.now
  const observability = input.observability
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
    }),
    observer: createPermissionObserver(observability?.permissionObserver),
    now,
  })

  return createOrchestrationRuntimeApi({
    model: input.provider,
    contextWindow,
    session: sessionPort,
    skill: skillPort,
    permission: permissionPort,
    tools: createToolPortFactory({
      observer: observability?.toolObserver,
      repository: input.repository,
      model: input.provider,
      contextWindow,
      sessionPort,
      runtimeObserver: observability?.runtimeObserver,
      skillObserver: createSkillObserver(observability?.skillObserver),
      searchBackend: input.searchBackend,
      agentProfileService(workspaceRoot) {
        return createAgentProfileService(workspaceRoot)
      },
      async createSubAgentRun(subAgentInput) {
        return createAgentSubRun({
          ...subAgentInput,
          model: input.provider,
          session: sessionPort,
          skill: skillPort,
          contextWindow,
          runtimeObserver: observability?.runtimeObserver,
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
    permissionPolicy: resolvePermissionPolicy(input.permissionPolicy),
    systemPrompt: input.systemPrompt,
    now,
    runtimeObserver: observability?.runtimeObserver,
  })
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
    repository,
    permissionRepository,
    observabilityRepository,
    close() {
      database?.close(false)
    },
  } satisfies {
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
      return input.repository.messages.create({
        sessionId: message.sessionId,
        runId: message.runId,
        role: "assistant",
        sequence: message.sequence,
        createdAt: message.createdAt,
      })
    },
    createSyntheticMessage(message) {
      return input.repository.messages.create({
        sessionId: message.sessionId,
        runId: message.runId,
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
  repository: StorageRepository
  model: OrchestrationModelPort
  contextWindow: { getContextWindow(): number }
  sessionPort: OrchestrationSessionPort
  runtimeObserver?: Pick<ObservabilityRuntimeApi, "runtimeObserver">["runtimeObserver"]
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
      let runtime!: ReturnType<typeof createBuiltinToolRuntime>
      runtime = createBuiltinToolRuntime({
        requestPermission(request) {
          return input.requestPermission(request)
        },
        searchBackend: config.searchBackend,
        extraTools: [
          createSkillTool({
            repository: config.repository,
            runtimeObserver: config.runtimeObserver,
            session: config.session,
            skill: config.skill,
            sessionId: input.sessionId,
            runId: input.runId,
            now: config.now,
          }),
          ...createSkillWriteTools({
            requestPermission(request) {
              return input.requestPermission(request)
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
                parentTools: {
                  ...createToolProviderFromRuntime({ runtime }),
                  async executeBatch(batchInput) {
                    const results = await batchExecutor.execute({
                      calls: batchInput.calls,
                      tools: createToolProviderFromRuntime({ runtime }),
                      availableTools: runtime.list(),
                      workspaceRoot: batchInput.workspaceRoot,
                      signal: batchInput.signal,
                    })

                    return results.map(manageBatchResult)
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
            },
          ),
        } satisfies T
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
        async executeBatch(batchInput) {
          const results = await batchExecutor.execute({
            calls: batchInput.calls,
            tools: provider,
            availableTools: runtime.list(),
            workspaceRoot: batchInput.workspaceRoot,
            signal: batchInput.signal,
          })

          return results.map(manageBatchResult)
        },
      }
    },
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

function createSkillTool(input: {
  repository: StorageRepository
  runtimeObserver?: Pick<ObservabilityRuntimeApi, "runtimeObserver">["runtimeObserver"]
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
              : ["Available skills:", ...catalog.map((skill) => `- ${skill.name}: ${skill.description}`)].join(
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
          reason: "activation",
        },
        occurredAt: input.now(),
      })
      const loaded = await input.skill.loadSkill({
        workspaceRoot: toolInput.workspaceRoot,
        name: name!,
      })
      throwIfToolAborted(toolInput.signal)
      input.runtimeObserver?.recordRuntimeEvent?.({
        sessionId: input.sessionId,
        runId: input.runId,
        event: {
          type: "skill.load.completed",
          skillName: loaded.name,
          skillPath: loaded.path,
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

function createToolPermissionDeniedError() {
  const error = new Error("Permission denied")
  error.name = "ToolPermissionDeniedError"
  return error
}

function createSkillPort(input: {
  runtime?: SkillRuntimeApi
}): OrchestrationSkillPort {
  const runtime = input.runtime ?? createWorkspaceSkillRuntime()

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
      }
    },
  }
}

function createPermissionSessionPort(input: {
  repository: StorageRepository
  session: Pick<SessionProvider["runs"], "transitionToRunning">
}) {
  return {
    getRun(runId: string) {
      return input.repository.runs.get(runId)
    },
    transitionRunToWaitingPermission(runId: string) {
      const run = input.repository.runs.get(runId)
      assertRunStatusTransition(run, "waiting_permission")
      return input.repository.runs.updateStatus({
        runId,
        status: "waiting_permission",
      })
    },
    transitionRunToRunning(runId: string) {
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
