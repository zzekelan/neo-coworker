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

      // Background loop failures are not surfaced yet by the minimal runtime.
      void runAgentLoop({
        prompt: runInput.prompt,
        provider: input.provider,
        queue,
        signal: controller.signal,
      }).catch(() => {})

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
