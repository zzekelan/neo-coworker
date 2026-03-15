import { join } from "node:path"
import {
  PermissionRequestNotPendingError,
  createConversationRunService as createSessionRunService,
  isTerminalRunStatus,
} from "../conversation/service"
import {
  createConversationRepository as createStorageRepository,
  openConversationDatabase as openStorageDatabase,
  type ConversationRepository as StorageRepository,
} from "../conversation/repo"
import type { Provider } from "../providers/types"
import type { RunHandle } from "./run-handle"
import { createEventQueue } from "./event-queue"
import type { RuntimeEvent } from "./events"
import {
  createPermissionCoordinator,
  type PermissionMode,
  type PermissionResponse,
} from "./permissions"
import { runAgentLoop } from "./loop"
import { createEditTool } from "./tools/edit"
import { createReadTool } from "./tools/read"
import { createToolRegistry } from "./tools/registry"
import { createSearchTool } from "./tools/search"
import { createShellTool } from "./tools/shell"
import { createWriteTool } from "./tools/write"

type RuntimeInput = {
  provider: Provider
  repository: StorageRepository
  permissionPolicy?: Partial<Record<"write" | "edit" | "shell", PermissionMode>>
  systemPrompt?: string
  now?: () => number
}

type RunInput = {
  sessionId: string
  runId: string
}

type CliRuntimeInput = RuntimeInput & {
  createStorageRepositoryImpl?: typeof createStorageRepository
  openStorageDatabaseImpl?: typeof openStorageDatabase
  repository?: StorageRepository
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
  permissions: ReturnType<typeof createPermissionCoordinator>
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
  const now = input.now ?? Date.now
  const sessionRuns = createSessionRunService({
    repository,
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
    const permissionRequest = repository.permissionRequests.get(response.requestId)
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

    sessionRuns.respondPermission({
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
      return
    }

    sessionRuns.cancelRun(runId)
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
      const permissions = createPermissionCoordinator(
        {
          write: "ask",
          edit: "ask",
          shell: "ask",
          ...input.permissionPolicy,
        },
        {
          onRequest(request) {
            sessionRuns.requestPermission({
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
      const tools = createToolRegistry([
        createReadTool(),
        createSearchTool(),
        createWriteTool({ permissions }),
        createEditTool({ permissions }),
        createShellTool({ permissions }),
      ])

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
      const repository =
        input.repository ??
        (input.createStorageRepositoryImpl ?? createStorageRepository)({
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
