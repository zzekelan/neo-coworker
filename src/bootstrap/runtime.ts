import { join } from "node:path"
import {
  createKnowledgeFileStorage,
  createKnowledgeRepository,
  createKnowledgeRuntimeApi,
  type KnowledgeAssetKind,
  type KnowledgeRepository,
  type StoredKnowledgeAsset,
  type StoredKnowledgeCandidate,
} from "../knowledge"
import {
  assertRunStatusTransition,
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
  type PermissionResponse,
  type PermissionRepository,
} from "../permission"
import {
  createToolProvider,
  type BuiltinResearchToolCallbacks,
  type ExternalContentDocument,
} from "../tool"
import {
  createNoopObservabilityRuntimeApi,
  createObservabilityRepository,
  createObservabilityRuntimeApi,
  type ObservabilityRepository,
  type ObservabilityRuntimeApi,
} from "../observability"
import type {
  OrchestrationModelPort,
  OrchestrationPermissionPort,
  OrchestrationSessionPort,
  OrchestrationToolPortFactory,
} from "../orchestration"
import {
  createOrchestrationActiveRunRegistry,
  createOrchestrationRuntimeApi,
  resolvePermissionPolicy,
  type OrchestrationActiveRunRegistry,
  type RunHandle,
  PermissionRequestNotAwaitingActiveRuntimeError,
} from "../orchestration"

type RuntimeInput = {
  provider: OrchestrationModelPort
  repository: StorageRepository
  permissionRepository: PermissionRepository
  observability?: Pick<
    ObservabilityRuntimeApi,
    "runtimeObserver" | "modelObserver" | "toolObserver" | "permissionObserver"
  >
  researchTools?: BuiltinResearchToolCallbacks
  permissionPolicy?: Partial<Record<string, PermissionMode>>
  activeRuns?: OrchestrationActiveRunRegistry
  systemPrompt?: string
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
  knowledgeRepository?: KnowledgeRepository
  fetchExternalContent?: BuiltinResearchToolCallbacks["fetchExternalContent"]
}

type CliRunInput = {
  prompt: string
  cwd: string
  workspaceRoot: string
}

export { PermissionRequestNotAwaitingActiveRuntimeError }

export function createRuntime(input: RuntimeInput) {
  const now = input.now ?? Date.now
  const observability = input.observability ?? createNoopObservabilityRuntimeApi()
  const sessionProvider = createSessionRuntimeApi({
    repository: input.repository,
    now,
  })

  return createOrchestrationRuntimeApi({
    model: input.provider,
    session: createSessionPort({
      repository: input.repository,
      session: sessionProvider.runs,
    }),
    permission: createPermissionPort({
      repository: input.permissionRepository,
      session: createPermissionSessionPort({
        repository: input.repository,
        session: sessionProvider.runs,
      }),
      observer: observability.permissionObserver,
      now,
    }),
    tools: createToolPortFactory({
      observer: observability.toolObserver,
      research: input.researchTools,
    }),
    activeRuns: input.activeRuns ?? createOrchestrationActiveRunRegistry(),
    permissionPolicy: resolvePermissionPolicy(input.permissionPolicy),
    systemPrompt: input.systemPrompt,
    now,
    runtimeObserver: observability.runtimeObserver,
  })
}

export function getDefaultCliStoragePath(workspaceRoot: string) {
  return join(workspaceRoot, ".agents", "agent.sqlite")
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
  knowledgeRepository?: KnowledgeRepository
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
  const knowledgeRepository =
    input.knowledgeRepository ??
    (database
      ? createKnowledgeRepository({
          database,
          now,
        })
      : undefined)

  return {
    repository,
    permissionRepository,
    observabilityRepository,
    knowledgeRepository,
    close() {
      database?.close(false)
    },
  } satisfies {
    repository: StorageRepository
    permissionRepository: PermissionRepository
    observabilityRepository?: ObservabilityRepository
    knowledgeRepository?: KnowledgeRepository
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
        knowledgeRepository: input.knowledgeRepository,
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
      const knowledge = storage.knowledgeRepository
        ? createKnowledgeRuntimeApi({
            repository: storage.knowledgeRepository,
            storage: createKnowledgeFileStorage(),
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
        researchTools: knowledge
          ? createResearchToolCallbacks({
              knowledge,
              fetchExternalContent: input.fetchExternalContent,
            })
          : undefined,
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

export function createResearchToolCallbacks(input: {
  knowledge: Pick<ReturnType<typeof createKnowledgeRuntimeApi>, "candidates" | "assets">
  fetchExternalContent?: (
    input: {
      url: string
      signal?: AbortSignal
    },
  ) => Promise<ExternalContentDocument> | ExternalContentDocument
  onCandidateStaged?: (candidate: StoredKnowledgeCandidate) => void
  onAssetCreated?: (asset: StoredKnowledgeAsset) => void
}) {
  return {
    fetchExternalContent: input.fetchExternalContent,
    stageFetchedSource(stageInput) {
      const candidate = input.knowledge.candidates.stage({
        workspaceRoot: stageInput.workspaceRoot,
        sessionId: stageInput.sessionId ?? null,
        runId: stageInput.runId ?? null,
        title: stageInput.title,
        sourceUrl: stageInput.sourceUrl,
        content: stageInput.content,
      })
      input.onCandidateStaged?.(candidate)

      return {
        id: candidate.id,
        title: candidate.title,
        sourceUrl: candidate.sourceUrl,
        excerpt: candidate.excerpt,
      }
    },
    listAssets(listInput) {
      return input.knowledge.assets
        .list(listInput.workspaceRoot, normalizeAssetKind(listInput.kind))
        .map((asset) => ({
          id: asset.id,
          kind: asset.kind,
          title: asset.title,
          path: asset.path,
          snippet: asset.snippet,
          sourceUrl: asset.sourceUrl,
        }))
    },
    async readAsset(readInput) {
      const asset = await input.knowledge.assets.read(readInput.assetId)

      return {
        id: asset.asset.id,
        kind: asset.asset.kind,
        title: asset.asset.title,
        path: asset.asset.path,
        content: asset.content,
        sourceUrl: asset.asset.sourceUrl,
      }
    },
    async searchAssets(searchInput) {
      const matches = await input.knowledge.assets.search({
        workspaceRoot: searchInput.workspaceRoot,
        query: searchInput.query,
        kind: normalizeAssetKind(searchInput.kind),
      })

      return matches.map((match) => ({
        id: match.asset.id,
        kind: match.asset.kind,
        title: match.asset.title,
        snippet: match.snippet,
      }))
    },
    async writeAsset(writeInput) {
      const asset = await input.knowledge.assets.create({
        workspaceRoot: writeInput.workspaceRoot,
        sessionId: writeInput.sessionId ?? null,
        runId: writeInput.runId ?? null,
        kind: normalizeRequiredAssetKind(writeInput.kind),
        title: writeInput.title,
        content: writeInput.content,
      })
      input.onAssetCreated?.(asset)

      return {
        id: asset.id,
        kind: asset.kind,
        title: asset.title,
        path: asset.path,
        snippet: asset.snippet,
        sourceUrl: asset.sourceUrl,
      }
    },
  } satisfies BuiltinResearchToolCallbacks
}

function createSessionPort(input: {
  repository: StorageRepository
  session: Pick<SessionProvider["runs"], "transitionToRunning" | "complete" | "fail" | "cancel">
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
    createAssistantMessage(message) {
      return input.repository.messages.create({
        sessionId: message.sessionId,
        runId: message.runId,
        role: "assistant",
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
  observer?: Pick<ObservabilityRuntimeApi, "permissionObserver">["permissionObserver"]
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
  research?: BuiltinResearchToolCallbacks
}): OrchestrationToolPortFactory {
  return {
    create(input) {
      return createToolProvider({
        requestPermission(request) {
          return input.requestPermission(request)
        },
        observer: config.observer,
        research: config.research,
        scope: {
          sessionId: input.sessionId,
          runId: input.runId,
        },
      })
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

function normalizeAssetKind(kind: string | undefined): KnowledgeAssetKind | undefined {
  if (
    kind === "source" ||
    kind === "note" ||
    kind === "finding" ||
    kind === "artifact"
  ) {
    return kind
  }

  return undefined
}

function normalizeRequiredAssetKind(kind: string): KnowledgeAssetKind {
  const normalized = normalizeAssetKind(kind)
  if (!normalized) {
    throw new Error(`Unknown research asset kind: ${kind}`)
  }

  return normalized
}
