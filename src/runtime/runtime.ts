import type { Provider } from "../providers/types"
import type { RunHandle } from "./run-handle"
import { createEventQueue } from "./event-queue"
import type { RuntimeEvent } from "./events"
import { runAgentLoop } from "./loop"
import { createReadTool } from "./tools/read"
import { createToolRegistry } from "./tools/registry"
import { createSearchTool } from "./tools/search"

type RuntimeInput = {
  provider: Provider
}

type RunInput = {
  prompt: string
  cwd: string
  workspaceRoot: string
}

export function createRuntime(input: RuntimeInput) {
  const tools = createToolRegistry([createReadTool(), createSearchTool()])

  return {
    async run(runInput: RunInput): Promise<RunHandle> {
      const controller = new AbortController()
      const queue = createEventQueue<RuntimeEvent>()

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
        },
        respondPermission() {},
      }
    },
  }
}
