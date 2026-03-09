import type { Provider } from "../providers/types"
import type { RuntimeEvent } from "./events"
import type { createEventQueue } from "./event-queue"
import type { ToolRegistry } from "./tools/types"

type AgentLoopInput = {
  prompt: string
  provider: Provider
  queue: ReturnType<typeof createEventQueue<RuntimeEvent>>
  signal: AbortSignal
  tools: ToolRegistry
  workspaceRoot: string
}

function isAbortError(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof Error && error.name === "AbortError")
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
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
      tools: input.tools.list(),
      signal: input.signal,
    })) {
      if (item.type === "text.delta") {
        input.queue.push({ type: "message.delta", text: item.text })
      }

      if (item.type === "tool.call") {
        const result = await input.tools.execute({
          toolName: item.name,
          args: JSON.parse(item.inputText),
          workspaceRoot: input.workspaceRoot,
        })

        input.queue.push({
          type: "tool.call.completed",
          callId: item.callId,
          name: item.name,
          output: result.output,
        })
      }
    }

    if (input.signal.aborted) {
      input.queue.push({ type: "run.cancelled", runId })
    } else {
      input.queue.push({ type: "run.completed", runId })
    }
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      input.queue.push({ type: "run.cancelled", runId })
    } else {
      input.queue.push({
        type: "run.failed",
        runId,
        error: getErrorMessage(error),
      })
    }
  } finally {
    input.queue.close()
  }
}
