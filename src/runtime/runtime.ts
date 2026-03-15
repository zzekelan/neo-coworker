import { join } from "node:path"
import {
  assertRunStatusTransition,
  createConversationRunService as createSessionRunService,
  isTerminalRunStatus,
} from "../conversation/service"
import {
  createConversationRepository as createStorageRepository,
  openConversationDatabase as openStorageDatabase,
  type ConversationRepository as StorageRepository,
} from "../conversation/repo"
import type { OrchestrationModelPort } from "../orchestration/ports/model"
import {
  createPermissionRepository,
  type PermissionRepository,
} from "../permission/repo"
import {
  PermissionRequestNotPendingError,
  type PermissionMode,
  type PermissionResponse,
} from "../permission/service"
import { createPermissionRuntimeApi } from "../permission/runtime/api"
import type { PermissionCoordinator } from "../permission/runtime/coordinator"
import { createToolProvider } from "../tool/wiring/provider"
import type { RunHandle } from "./run-handle"
import { createEventQueue } from "./event-queue"
import type { RuntimeEvent } from "./events"
import { runAgentLoop } from "./loop"

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

type ActiveRunState = {
  storageIdentity: string
  sessionId: string
  runId: string
  controller: AbortController
  permissions: PermissionCoordinator
  pendingPermissionIds: Set<string>
}

const sharedActiveRuns = new Map<string, ActiveRunState>()

export class PermissionRequestNotAwaitingActiveRuntimeError extends Error {
  readonly requestId: string
  readonly runId: string
  readonly sessionId: string

  constructor(input: { requestId: string; runId: string; sessionId: string }) {
    super(`Permission request ${input.requestId} is not awaiting a reply in the active runtime`)
    this.name = "PermissionRequestNotAwaitingActiveRuntimeError"
    this.requestId = input.requestId
    this.runId = input.runId
    this.sessionId = input.sessionId
  }
}

function getActiveRunKey(input: { storageIdentity: string; sessionId: string; runId: string }) {
  return `${input.storageIdentity}:${input.sessionId}:${input.runId}`
}

export function createRuntime(input: RuntimeInput) {
  const repository = input.repository
  const permissionRepository = input.permissionRepository
  const now = input.now ?? Date.now
  const sessionRuns = createSessionRunService({
    repository,
    now,
  })
  const permissionsApi = createPermissionRuntimeApi({
    repository: permissionRepository,
    conversation: createPermissionConversationPort({
      repository,
      sessionRuns,
    }),
    now,
  })

  function clearActiveRun(activeRun: ActiveRunState) {
    activeRun.pendingPermissionIds.clear()
    sharedActiveRuns.delete(
      getActiveRunKey({
        storageIdentity: activeRun.storageIdentity,
        sessionId: activeRun.sessionId,
        runId: activeRun.runId,
      }),
    )
  }

  function respondPermission(response: PermissionResponse) {
    const permissionRequest = permissionsApi.getPermissionRequest(response.requestId)
    const activeRun = sharedActiveRuns.get(
      getActiveRunKey({
        storageIdentity: repository.storageIdentity,
        sessionId: permissionRequest.sessionId,
        runId: permissionRequest.runId,
      }),
    )

    if (!activeRun || !activeRun.pendingPermissionIds.has(response.requestId)) {
      if (permissionRequest.status !== "pending") {
        throw new PermissionRequestNotPendingError({
          requestId: permissionRequest.id,
          status: permissionRequest.status,
        })
      }

      throw new PermissionRequestNotAwaitingActiveRuntimeError({
        requestId: permissionRequest.id,
        runId: permissionRequest.runId,
        sessionId: permissionRequest.sessionId,
      })
    }

    permissionsApi.respondPermission({
      requestId: response.requestId,
      decision: response.decision,
      resolvedAt: now(),
    })
    activeRun.pendingPermissionIds.delete(response.requestId)
    activeRun.permissions.resolve(response)
  }

  function cancelRun(runId: string) {
    const run = repository.runs.get(runId)
    const activeRun = sharedActiveRuns.get(
      getActiveRunKey({
        storageIdentity: repository.storageIdentity,
        sessionId: run.sessionId,
        runId,
      }),
    )

    if (run.status === "cancelled" || isTerminalRunStatus(run.status)) {
      return
    }

    if (!activeRun) {
      sessionRuns.cancelRun(runId)
      permissionsApi.cancelPendingRequestsByRun(runId, now())
      return
    }

    sessionRuns.cancelRun(runId)
    permissionsApi.cancelPendingRequestsByRun(runId, now())
    activeRun.controller.abort()
    activeRun.permissions.cancelAll()
  }

  return {
    async run(runInput: RunInput): Promise<RunHandle> {
      const activeRunKey = getActiveRunKey({
        storageIdentity: repository.storageIdentity,
        sessionId: runInput.sessionId,
        runId: runInput.runId,
      })

      if (sharedActiveRuns.has(activeRunKey)) {
        throw new Error(`Run ${runInput.runId} is already active`)
      }

      const session = repository.sessions.get(runInput.sessionId)
      const controller = new AbortController()
      const queue = createEventQueue<RuntimeEvent>()
      const permissions = permissionsApi.createCoordinator(
        {
          write: "ask",
          edit: "ask",
          shell: "ask",
          ...input.permissionPolicy,
        },
        {
          onRequest(request) {
            permissionsApi.requestPermission({
              runId: runInput.runId,
              permissionRequest: {
                id: request.requestId,
                toolName: request.toolName,
                reason: request.reason,
                createdAt: now(),
              },
            })
            activeRun.pendingPermissionIds.add(request.requestId)
            queue.push({
              type: "permission.requested",
              requestId: request.requestId,
              toolName: request.toolName,
              reason: request.reason,
            })
          },
        },
      )
      const activeRun: ActiveRunState = {
        storageIdentity: repository.storageIdentity,
        sessionId: session.id,
        runId: runInput.runId,
        controller,
        permissions,
        pendingPermissionIds: new Set<string>(),
      }
      sharedActiveRuns.set(activeRunKey, activeRun)
      const tools = createToolProvider({
        requestPermission(request) {
          return permissions.request(request)
        },
      })

      void runAgentLoop({
        sessionId: session.id,
        runId: runInput.runId,
        repository,
        sessionRuns,
        provider: input.provider,
        queue,
        signal: controller.signal,
        tools,
        workspaceRoot: session.workspaceRoot,
        systemPrompt: input.systemPrompt ?? "You are the agent runtime.",
        now,
      }).finally(() => {
        clearActiveRun(activeRun)
      })

      return {
        events: queue.stream(),
        cancel() {
          cancelRun(runInput.runId)
        },
        respondPermission(response) {
          respondPermission(response)
        },
      }
    },
    respondPermission,
    cancelRun,
  }
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

function createPermissionConversationPort(input: {
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
    respondPermission(response) {
      handle.respondPermission(response)
    },
  }
}
