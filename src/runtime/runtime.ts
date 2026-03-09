import { join } from "node:path"
import { createSessionRunService } from "../session"
import {
  createStorageRepository,
  openStorageDatabase,
  type StorageRepository,
} from "../storage"
import type { Provider } from "../providers/types"
import type { RunHandle } from "./run-handle"
import { createEventQueue } from "./event-queue"
import type { RuntimeEvent } from "./events"
import { createPermissionCoordinator, type PermissionMode } from "./permissions"
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

export function createRuntime(input: RuntimeInput) {
  const repository = input.repository
  const now = input.now ?? Date.now
  const sessionRuns = createSessionRunService({
    repository,
    now,
  })

  return {
    async run(runInput: RunInput): Promise<RunHandle> {
      const session = repository.sessions.get(runInput.sessionId)
      const controller = new AbortController()
      const queue = createEventQueue<RuntimeEvent>()
      const pendingPermissions = new Set<string>()
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
            pendingPermissions.add(request.requestId)
            queue.push({
              type: "permission.requested",
              requestId: request.requestId,
              toolName: request.toolName,
              reason: request.reason,
            })
          },
        },
      )
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
        pendingPermissions.clear()
      })

      return {
        events: queue.stream(),
        cancel() {
          controller.abort()
          permissions.cancelAll()
        },
        respondPermission(response) {
          if (!pendingPermissions.has(response.requestId)) {
            throw new Error(`Unknown permission request: ${response.requestId}`)
          }

          repository.permissionRequests.updateStatus({
            requestId: response.requestId,
            status: response.decision === "allow" ? "approved" : "denied",
            resolvedAt: now(),
          })
          sessionRuns.resumeRun(runInput.runId)
          pendingPermissions.delete(response.requestId)
          permissions.resolve(response)
        },
      }
    },
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
