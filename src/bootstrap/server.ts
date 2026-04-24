import {
  createSessionRepository,
  openSessionDatabase,
  SessionBusyError,
  SessionNotFoundError,
  type SessionRepository,
} from "../session"
import { createPermissionRepository, type PermissionRepository } from "../permission"
import {
  createObservabilityRepository,
  createObservabilityRuntimeApi,
  type ObservabilityRepository,
} from "../observability"
import { createWorkspaceSkillRuntime } from "../skill"
import {
  createDefaultProvider,
  resolveContextWindowSize,
  resolveProviderCapabilities,
  resolveRuntimeThinkingConfig,
} from "./provider"
import { createDefaultSearchBackend } from "./search"
import { createOrchestrationModelPort, createRuntime } from "./runtime"
import { getServerStoragePath } from "./paths"
import { readEnvWithFallback } from "./env"
import { createAgentProfileService, type AgentProfileService } from "../agent"
import type { ResolvedProviderCapabilities } from "./provider-capabilities"

const DEFAULT_SERVER_HOST = "127.0.0.1"
const DEFAULT_SERVER_PORT = 3100

export type StandaloneServerConfig = {
  host: string
  port: number
  databasePath: string
}

export function getDefaultStandaloneServerStoragePath(cwd: string = process.cwd()) {
  return getServerStoragePath(cwd)
}

export function resolveStandaloneServerConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): StandaloneServerConfig {
  return {
    host: readEnvWithFallback(env, "NCOWORKER_SERVER_HOST", "AGENT_SERVER_HOST") ?? DEFAULT_SERVER_HOST,
    port: parseServerPort(readEnvWithFallback(env, "NCOWORKER_SERVER_PORT", "AGENT_SERVER_PORT")),
    databasePath:
      env.NCOWORKER_SERVER_DB_PATH ?? getDefaultStandaloneServerStoragePath(cwd),
  }
}

export async function createStandaloneServerComposition(input: {
  env?: Record<string, string | undefined>
  cwd?: string
  now?: () => number
  createDefaultProviderImpl?: typeof createDefaultProvider
  resolveProviderCapabilitiesImpl?: typeof resolveProviderCapabilities
  resolveContextWindowSizeImpl?: typeof resolveContextWindowSize
  openSessionDatabaseImpl?: typeof openSessionDatabase
  createSessionRepositoryImpl?: typeof createSessionRepository
  createPermissionRepositoryImpl?: typeof createPermissionRepository
  createObservabilityRepositoryImpl?: typeof createObservabilityRepository
  createRuntimeImpl?: typeof createRuntime
} = {}) {
  const env = input.env ?? process.env
  const cwd = input.cwd ?? process.cwd()
  const now = input.now ?? Date.now
  const config = resolveStandaloneServerConfig(env, cwd)
  const database = (input.openSessionDatabaseImpl ?? openSessionDatabase)(config.databasePath)

  try {
    const repository = (input.createSessionRepositoryImpl ?? createSessionRepository)({
      database,
      now,
    })
    const permissionRepository =
      (input.createPermissionRepositoryImpl ?? createPermissionRepository)({
        database,
        now,
      })
    const observabilityRepository =
      (input.createObservabilityRepositoryImpl ?? createObservabilityRepository)({
        database,
        now,
      })
    const observability = createObservabilityRuntimeApi({
      repository: observabilityRepository,
      now,
    })
    const resolvedCapabilities = await (input.resolveProviderCapabilitiesImpl ?? resolveProviderCapabilities)({
      env,
      cwd,
    })
    const runtimeThinking = resolveRuntimeThinkingConfig({
      env,
      resolvedCapabilities,
    })
    const contextWindow = await (input.resolveContextWindowSizeImpl ?? resolveContextWindowSize)({
      env,
    })
    const provider = await (input.createDefaultProviderImpl ?? createDefaultProvider)({
      env,
      modelObserver: observability.modelObserver,
      resolvedCapabilities,
    })
    const orchestrationModel = createOrchestrationModelPort(provider)
    const searchBackend = createDefaultSearchBackend({
      env,
    })
    const skillRuntime = createWorkspaceSkillRuntime()
    const agentProfileServices = new Map<string, AgentProfileService>()
    const createRuntimeImpl = input.createRuntimeImpl ?? createRuntime
    const sessionDeletion = createSessionDeletionCoordinator({
      database,
      repository,
    })
    const getAgentProfileService = (workspaceRoot: string) => {
      const cached = agentProfileServices.get(workspaceRoot)
      if (cached) {
        return cached
      }

      const service = createAgentProfileService(workspaceRoot)
      agentProfileServices.set(workspaceRoot, service)
      return service
    }

    return {
      config,
      provider,
      repository,
      permissionRepository,
      observabilityRepository,
      exportRunTrace(runId: string) {
        return observability.exportRunTrace(runId)
      },
      listSkillCatalog(workspaceRoot: string) {
        return skillRuntime.listCatalog(workspaceRoot)
      },
      async listPrimaryAgents(workspaceRoot?: string) {
        const agents = await getAgentProfileService(workspaceRoot ?? cwd).listPrimaryAgents()
        return agents.map((agent) => ({ name: agent.name, description: agent.description ?? "" }))
      },
      createRuntimeImpl(runtimeInput: {
        repository: SessionRepository
        permissionRepository: PermissionRepository
        now: () => number
      }) {
        return createRuntimeImpl({
          provider: orchestrationModel,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          observability,
          searchBackend,
          contextWindow: contextWindow.contextWindow,
          thinking: runtimeThinking,
          telemetry: {
            capabilityResolution: buildCapabilityTelemetry(resolvedCapabilities),
            contextWindow: {
              contextWindow: contextWindow.contextWindow,
              source: mapContextWindowSource(contextWindow.source),
            },
            modelClassification: {
              model: resolvedCapabilities.model,
              providerFamily: classifyProviderFamily(resolvedCapabilities),
            },
          },
          now: runtimeInput.now,
        })
      },
      deleteSession(sessionId: string) {
        sessionDeletion.deleteSession(sessionId)
      },
      closeDatabase() {
        database.close(false)
      },
    } satisfies {
      config: StandaloneServerConfig
      provider: Awaited<ReturnType<typeof createDefaultProvider>>
      repository: SessionRepository
      permissionRepository: PermissionRepository
      observabilityRepository: ObservabilityRepository
      exportRunTrace(runId: string): ReturnType<typeof observability.exportRunTrace>
      listSkillCatalog(workspaceRoot: string): ReturnType<typeof skillRuntime.listCatalog>
      listPrimaryAgents(workspaceRoot?: string): Promise<Array<{ name: string; description: string }>>
      createRuntimeImpl(input: {
        repository: SessionRepository
        permissionRepository: PermissionRepository
        now: () => number
      }): Pick<
        ReturnType<typeof createRuntime>,
        "run" | "cancelRun" | "respondPermission" | "setSessionThinkingOverride"
      >
      deleteSession(sessionId: string): void
      closeDatabase(): void
    }
  } catch (error) {
    database.close(false)
    throw error
  }
}

export function createSessionDeletionCoordinator(input: {
  database: ReturnType<typeof openSessionDatabase>
  repository: SessionRepository
}) {
  const deleteSessionTransaction = input.database.transaction((sessionId: string) => {
    input.repository.sessions.get(sessionId)

    const activeRun = input.repository.runs.getActiveBySession(sessionId)
    if (activeRun) {
      throw new SessionBusyError({
        sessionId,
        activeRunId: activeRun.id,
      })
    }

    input.database.query("DELETE FROM run_event WHERE session_id = ?").run(sessionId)
    const deleted = input.database.query("DELETE FROM session WHERE id = ?").run(sessionId)

    if (deleted.changes === 0) {
      throw new SessionNotFoundError("session", sessionId)
    }
  })

  return {
    deleteSession(sessionId: string) {
      deleteSessionTransaction(sessionId)
    },
  }
}

function parseServerPort(value: string | undefined) {
  if (value == null) {
    return DEFAULT_SERVER_PORT
  }

  if (!/^\d+$/.test(value)) {
    throw new Error("NCOWORKER_SERVER_PORT must be a valid integer")
  }

  const port = Number.parseInt(value, 10)
  if (port < 1 || port > 65535) {
    throw new Error("NCOWORKER_SERVER_PORT must be between 1 and 65535")
  }

  return port
}

function buildCapabilityTelemetry(resolvedCapabilities: ResolvedProviderCapabilities) {
  return {
    model: resolvedCapabilities.model,
    provider: resolvedCapabilities.provider,
    providerFamily: classifyProviderFamily(resolvedCapabilities),
    catalogSource: resolvedCapabilities.catalog.source,
    catalogMiss: resolvedCapabilities.catalog.miss,
    reasoningSource: mapCapabilitySource(resolvedCapabilities.reasoning.source),
    toolCallSource: mapCapabilitySource(resolvedCapabilities.toolCall.source),
    interleavedSource: mapCapabilitySource(resolvedCapabilities.interleaved.source),
    interleavedField: resolvedCapabilities.interleaved.field,
    reasoningEffortSource: mapCapabilitySource(resolvedCapabilities.reasoningEffort.source),
    thinkingSource: mapCapabilitySource(resolvedCapabilities.thinkingControls.thinking.source),
    thinkingEffortSource: mapCapabilitySource(resolvedCapabilities.thinkingControls.reasoningEffort.source),
  } as const
}

function classifyProviderFamily(resolvedCapabilities: ResolvedProviderCapabilities) {
  return resolvedCapabilities.providerId === "moonshotai" || resolvedCapabilities.model.startsWith("kimi-")
    ? "kimi"
    : "generic"
}

function mapCapabilitySource(source: ResolvedProviderCapabilities["reasoning"]["source"]) {
  return source === "override" ? "config" : source
}

function mapContextWindowSource(source: "provider" | "models.dev" | "env" | "default") {
  switch (source) {
    case "env":
      return "config"
    case "provider":
      return "/models"
    case "models.dev":
      return "models.dev"
    default:
      return "default"
  }
}
