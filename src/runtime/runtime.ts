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
  permissionPolicy?: Partial<Record<"write" | "edit" | "shell", PermissionMode>>
}

type RunInput = {
  prompt: string
  cwd: string
  workspaceRoot: string
}

export function createRuntime(input: RuntimeInput) {
  return {
    async run(runInput: RunInput): Promise<RunHandle> {
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
        prompt: runInput.prompt,
        provider: input.provider,
        queue,
        signal: controller.signal,
        tools,
        workspaceRoot: runInput.workspaceRoot,
      })

      return {
        events: queue.stream(),
        cancel() {
          controller.abort()
          permissions.cancelAll()
        },
        respondPermission(response) {
          permissions.resolve(response)
        },
      }
    },
  }
}
