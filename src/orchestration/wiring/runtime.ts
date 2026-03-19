import { join } from "node:path"
import {
  assertRunStatusTransition,
  createSessionRunService,
} from "../../session/service"
import {
  createSessionRepository as createStorageRepository,
  openSessionDatabase as openStorageDatabase,
  type SessionRepository as StorageRepository,
} from "../../session/repo"
import {
  createPermissionRepository,
  type PermissionRepository,
} from "../../permission/repo"
import type { PermissionMode, PermissionResponse } from "../../permission/service"
import { createPermissionRuntimeApi } from "../../permission/runtime/api"
import { createToolProvider } from "../../tool/wiring/provider"
import type { OrchestrationSessionPort } from "../ports/session"
import type { OrchestrationModelPort } from "../ports/model"
import type { OrchestrationPermissionPort } from "../ports/permission"
import type { OrchestrationToolPortFactory } from "../ports/tool"
import {
  createOrchestrationRuntimeApi,
  type RunHandle,
} from "../runtime/api"

type RuntimeInput = {
  provider: OrchestrationModelPort
  repository: StorageRepository
  permissionRepository: PermissionRepository
  permissionPolicy?: Partial<Record<"write" | "edit" | "shell", PermissionMode>>
  systemPrompt?: string
  now?: () => number
}

type RunInput = {
  sessionId: string
  runId: string
}

type CliRuntimeInput = Omit<RuntimeInput, "repository" | "permissionRepository"> & {
  createStorageRepositoryImpl?: typeof createStorageRepository
  createPermissionRepositoryImpl?: typeof createPermissionRepository
  openStorageDatabaseImpl?: typeof openStorageDatabase
  repository?: StorageRepository
  permissionRepository?: PermissionRepository
}

type CliRunInput = {
  prompt: string
  cwd: string
  workspaceRoot: string
}

export { PermissionRequestNotAwaitingActiveRuntimeError } from "../runtime/api"

export function createRuntime(input: RuntimeInput) {
  const now = input.now ?? Date.now
  const sessionRuns = createSessionRunService({
    repository: input.repository,
    now,
  })

  return createOrchestrationRuntimeApi({
    model: input.provider,
    session: createSessionPort({
      repository: input.repository,
      sessionRuns,
    }),
    permission: createPermissionPort({
      repository: input.permissionRepository,
      session: createPermissionSessionPort({
        repository: input.repository,
        sessionRuns,
      }),
      now,
    }),
    tools: createToolPortFactory(),
    permissionPolicy: input.permissionPolicy,
    systemPrompt: input.systemPrompt,
    now,
  })
}

export function getDefaultCliStoragePath(workspaceRoot: string) {
  return join(workspaceRoot, ".agents", "agent.sqlite")
}

export function createCliRuntime(input: CliRuntimeInput) {
  const now = input.now ?? Date.now

  return {
    async run(runInput: CliRunInput): Promise<RunHandle> {
      const database =
        input.repository == null
          ? (input.openStorageDatabaseImpl ?? openStorageDatabase)(
              getDefaultCliStoragePath(runInput.workspaceRoot),
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
      const sessionRuns = createSessionRunService({
        repository,
        now,
      })
      const runtime = createRuntime({
        ...input,
        repository,
        permissionRepository,
        now,
      })

      try {
        const session = repository.sessions.create({
          directory: runInput.cwd,
          workspaceRoot: runInput.workspaceRoot,
          createdAt: now(),
        })
        const started = sessionRuns.startRun({
          sessionId: session.id,
          trigger: "cli",
          createdAt: now(),
          messageCreatedAt: now(),
        })

        repository.parts.create({
          sessionId: session.id,
          runId: started.run.id,
          messageId: started.message.id,
          kind: "text",
          sequence: 0,
          text: runInput.prompt,
          createdAt: now(),
        })

        const handle = await runtime.run({
          sessionId: session.id,
          runId: started.run.id,
        })

        return database ? withDatabaseCleanup(handle, () => database.close(false)) : handle
      } catch (error) {
        database?.close(false)
        throw error
      }
    },
  }
}

function createSessionPort(input: {
  repository: StorageRepository
  sessionRuns: Pick<
    ReturnType<typeof createSessionRunService>,
    "transitionRunToRunning" | "completeRun" | "failRun" | "cancelRun"
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
      return input.sessionRuns.transitionRunToRunning(runId)
    },
    completeRun(runId) {
      return input.sessionRuns.completeRun(runId)
    },
    failRun(run) {
      return input.sessionRuns.failRun(run)
    },
    cancelRun(runId) {
      return input.sessionRuns.cancelRun(runId)
    },
  }
}

function createPermissionPort(input: {
  repository: PermissionRepository
  session: ReturnType<typeof createPermissionSessionPort>
  now: () => number
}): OrchestrationPermissionPort {
  const permissionsApi = createPermissionRuntimeApi({
    repository: input.repository,
    session: input.session,
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

function createToolPortFactory(): OrchestrationToolPortFactory {
  return {
    create(input) {
      return createToolProvider({
        requestPermission(request) {
          return input.requestPermission(request)
        },
      })
    },
  }
}

function createPermissionSessionPort(input: {
  repository: StorageRepository
  sessionRuns: Pick<ReturnType<typeof createSessionRunService>, "transitionRunToRunning">
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
      return input.sessionRuns.transitionRunToRunning(runId)
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
