import type { Provider } from "../providers/types"
import type { RuntimeEvent } from "./events"
import type { createEventQueue } from "./event-queue"

type AgentLoopInput = {
  prompt: string
  provider: Provider
  queue: ReturnType<typeof createEventQueue<RuntimeEvent>>
  signal: AbortSignal
}

export async function runAgentLoop(input: AgentLoopInput) {
  const runId = "run_1"

  input.queue.push({ type: "run.started", runId })
  input.queue.push({ type: "message.started", role: "assistant" })

  try {
    for await (const item of input.provider.streamTurn({
      system: "You are the agent runtime.",
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: input.prompt }],
        },
      ],
      tools: [],
      signal: input.signal,
    })) {
      if (item.type === "text.delta") {
        input.queue.push({ type: "message.delta", text: item.text })
      }

      if (item.type === "tool.call") {
        input.queue.push({
          type: "tool.call.completed",
          callId: item.callId,
          name: item.name,
        })
      }
    }

    input.queue.push({ type: "run.completed", runId })
  } finally {
    input.queue.close()
  }
}
