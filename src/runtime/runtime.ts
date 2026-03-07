import type { Provider } from "../providers/types"
import type { RunHandle } from "./run-handle"
import { createEventQueue } from "./event-queue"
import type { RuntimeEvent } from "./events"
import { runAgentLoop } from "./loop"

type RuntimeInput = {
  provider: Provider
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

      await runAgentLoop({
        prompt: runInput.prompt,
        provider: input.provider,
        queue,
        signal: controller.signal,
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
