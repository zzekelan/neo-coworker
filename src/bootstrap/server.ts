import { join } from "node:path"
import {
  createKnowledgeFileStorage,
  createKnowledgeRepository,
  createKnowledgeRuntimeApi,
  type KnowledgeRepository,
} from "../knowledge"
import {
  createSessionRepository,
  openSessionDatabase,
  type SessionRepository,
} from "../session"
import { createPermissionRepository, type PermissionRepository } from "../permission"
import {
  createObservabilityRepository,
  createObservabilityRuntimeApi,
  type ObservabilityRepository,
} from "../observability"
import { createDefaultProvider } from "./provider"
import {
  createResearchToolCallbacks,
  createRuntime,
} from "./runtime"

const DEFAULT_SERVER_HOST = "127.0.0.1"
const DEFAULT_SERVER_PORT = 3100

export type StandaloneServerConfig = {
  host: string
  port: number
  databasePath: string
}

export function getDefaultStandaloneServerStoragePath(cwd: string = process.cwd()) {
  return join(cwd, ".agents", "server.sqlite")
}

export function resolveStandaloneServerConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): StandaloneServerConfig {
  return {
    host: readEnvValue(env, "AGENT_SERVER_HOST") ?? DEFAULT_SERVER_HOST,
    port: parseServerPort(readEnvValue(env, "AGENT_SERVER_PORT")),
    databasePath:
      readEnvValue(env, "AGENT_SERVER_DB_PATH") ?? getDefaultStandaloneServerStoragePath(cwd),
  }
}

export async function createStandaloneServerComposition(input: {
  env?: Record<string, string | undefined>
  cwd?: string
  now?: () => number
  createDefaultProviderImpl?: typeof createDefaultProvider
  openSessionDatabaseImpl?: typeof openSessionDatabase
  createSessionRepositoryImpl?: typeof createSessionRepository
  createPermissionRepositoryImpl?: typeof createPermissionRepository
  createObservabilityRepositoryImpl?: typeof createObservabilityRepository
  createKnowledgeRepositoryImpl?: typeof createKnowledgeRepository
  createRuntimeImpl?: typeof createRuntime
} = {}) {
  const env = input.env ?? process.env
  const now = input.now ?? Date.now
  const config = resolveStandaloneServerConfig(env, input.cwd)
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
    const knowledgeRepository =
      (input.createKnowledgeRepositoryImpl ?? createKnowledgeRepository)({
        database,
        now,
      })
    const knowledge = createKnowledgeRuntimeApi({
      repository: knowledgeRepository,
      storage: createKnowledgeFileStorage(),
      now,
    })
    const observability = createObservabilityRuntimeApi({
      repository: observabilityRepository,
      now,
    })
    const provider = await (input.createDefaultProviderImpl ?? createDefaultProvider)({
      env,
      modelObserver: observability.modelObserver,
    })
    const createRuntimeImpl = input.createRuntimeImpl ?? createRuntime

    return {
      config,
      provider,
      repository,
      permissionRepository,
      observabilityRepository,
      knowledgeRepository,
      knowledge,
      exportRunTrace(runId: string) {
        return observability.exportRunTrace(runId)
      },
      createRuntimeImpl(runtimeInput: {
        repository: SessionRepository
        permissionRepository: PermissionRepository
        now: () => number
        researchTools?: Parameters<typeof createRuntime>[0]["researchTools"]
      }) {
        return createRuntimeImpl({
          provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          observability,
          researchTools:
            runtimeInput.researchTools ??
            createResearchToolCallbacks({
              knowledge,
            }),
          now: runtimeInput.now,
        })
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
      knowledgeRepository: KnowledgeRepository
      knowledge: ReturnType<typeof createKnowledgeRuntimeApi>
      exportRunTrace(runId: string): ReturnType<typeof observability.exportRunTrace>
      createRuntimeImpl(input: {
        repository: SessionRepository
        permissionRepository: PermissionRepository
        now: () => number
        researchTools?: Parameters<typeof createRuntime>[0]["researchTools"]
      }): Pick<ReturnType<typeof createRuntime>, "run" | "cancelRun" | "respondPermission">
      closeDatabase(): void
    }
  } catch (error) {
    database.close(false)
    throw error
  }
}

function readEnvValue(env: Record<string, string | undefined>, key: string) {
  const value = env[key]?.trim()
  return value ? value : undefined
}

function parseServerPort(value: string | undefined) {
  if (value == null) {
    return DEFAULT_SERVER_PORT
  }

  if (!/^\d+$/.test(value)) {
    throw new Error("AGENT_SERVER_PORT must be a valid integer")
  }

  const port = Number.parseInt(value, 10)
  if (port < 1 || port > 65535) {
    throw new Error("AGENT_SERVER_PORT must be between 1 and 65535")
  }

  return port
}
